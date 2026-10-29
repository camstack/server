import { ServiceBroker, type ServiceSchema } from 'moleculer'

import { randomUUID } from 'node:crypto'
import type {
  CallFn,
  ChildCapDescriptor,
  HubServiceDeps,
  ProviderOwnerToken,
  RegisteredAddonManifest,
  RegisteredChild,
  RegisterNodeParams,
} from '@camstack/system'
import {
  AGENT_READINESS_SERVICE_NAME,
  CapRouteError,
  CapRouteResolver,
  callWithServiceDiscovery,
  capActionName,
  createBroker,
  createHubCapForwardService,
  createHubService,
  createLocalTransport,
  createParentUnownedCallHandler,
  createProcessService,
  createReadinessServiceForRegistry,
  createStreamProbeBrokerService,
  createUdsEventBridge,
  expandCapMethods,
  getBrokerTlsTransporter,
  getCapUsageRegistry,
  HubNodeRegistry,
  getProcessMeshCertificateRegistry,
  getProcessPeerLeaf,
  isInfraCapability,
  LocalChildRegistry,
  localEndpointPath,
  registerEventBusService,
  serializeTypedArrays,
  setNodeEventInterest,
  onLocalEventInterestChange,
  getLocalEventInterest,
  emitProcessNodeRegistered,
  setProcessMeshPeerTransportLookup,
  setProcessMeshTlsEnabler,
  subscribePassthrough,
  udsChildLogToWorkerEntry,
  UNCLAIMED,
  answerClaimedGetStatus,
  answerDeviceCallRedirect,
  type DeviceCallRedirectHook,
} from '@camstack/system'
import type { CapabilityDefinition, StatusOverlayAnswer } from '@camstack/types'
import { EventCategory, emitReadiness, errMsg, ReadinessRegistry } from '@camstack/types'
import {
  addonPinOf,
  aggregateCollectionCall,
  COLLECTION_ARRAY_METHODS,
  devicePinOf,
  pinnedCollectionCall,
  pinnedDeviceCollectionCall,
} from '../../api/trpc/cap-router-runtime.js'
import { isCoreServiceCapName } from '../../api/trpc/core-cap-bridge.js'
import { CapabilityService } from '../capability/capability.service'
import { ConfigService } from '../config/config.service'
import { EventBusService } from '../events/event-bus.service'
import { LoggingService } from '../logging/logging.service'
import { StreamProbeService } from '../streaming/stream-probe.service'
import { filterAgentAuthoritativeRecords } from './agent-readiness-pull.js'
import { requestAgentRegistration } from './agent-registration-request.js'
import { HubMeshGuard } from './hub-mesh-guard.js'
import { readHubServerVersion } from './hub-server-version.js'
import { buildCapCallFn } from './cap-call-fn.js'
import {
  createHubResidentProviderLookup,
  createInProcessProviderLookup,
  createNodeCapAuthority,
} from './cap-route-authority.js'

/** Moleculer logger factory internals touched when hub log level changes. */
interface MoleculerLogFactory {
  appenders?: Array<{ opts: { level: string } }>
  cache?: Map<string, unknown>
}

/**
 * One `(addon, capability)` pair that a node manifest applies onto the
 * CapabilityRegistry, with its resolved `CapabilityDefinition`. Built by
 * `applyNodeManifest`'s diff so the register loop never re-resolves the
 * cap def. Keyed in the diff map by `` `${registryKey}::${capName}` ``.
 */
interface AppliedCapEntry {
  readonly addonId: string
  readonly capName: string
  readonly capDef: CapabilityDefinition
}

export class MoleculerService {
  readonly broker: ServiceBroker
  private readonly logger: ReturnType<LoggingService['createLogger']>
  /**
   * D802, D857 — who may talk to the hub over the mesh: the broker middleware
   * that admits a node by its CERTIFICATE (verified at the TLS handshake),
   * refuses the rest and strips forged identities.
   */
  private readonly meshGuard: HubMeshGuard
  /**
   * D3 authority: union of every node's manifest delivered via
   * `$hub.registerNode`. Populated by `onRegisterNode` in `hubDeps`.
   */
  private readonly nodeRegistry = new HubNodeRegistry()

  /**
   * nodeId → the owner token of the INCARNATION whose manifest currently backs
   * that node's capability registrations.
   *
   * A node id is not unique over time: `resolveRunnerId` is deterministic, so a
   * runner replaced by an addon update reconnects as the same `hub/<runner>`
   * node. Without an incarnation the predecessor's teardown and the successor's
   * registration are the same `(cap, addonId)` key, and the teardown wins by
   * arriving last — `recording`, `storage-evictable` and `recording-export`
   * were unregistered from a healthy process for 7 hours on 2026-08-20.
   * Populated only for transports that can observe an incarnation (UDS
   * children); remote nodes stay ownerless and behave exactly as before.
   * See `docs/decisions/adr-0188-an-unregister-carries-proof-of-ownership.md`.
   */
  private readonly nodeOwners = new Map<string, ProviderOwnerToken>()

  /**
   * Skips the manifest rebuild for a child re-register that carries nothing new
   * — 246 of them in 30 minutes with zero respawns, measured live 2026-08-25.
   * See {@link ChildManifestGate}.
   */
  private readonly childManifestGate = new ChildManifestGate()

  /**
   * Receives every child register frame that DESCRIBES its custom-action
   * catalogs (the post-init one and every re-register after it). Consulted
   * BEFORE {@link ChildManifestGate}: the gate compares caps, and a post-init
   * register of a non-device runner carries the same caps as its pre-init one
   * — skipping it would lose the only frame that carries the catalogs (D444).
   * The consumer (`AddonRegistryService`) dedupes by catalog fingerprint.
   */
  private childCustomActionsHandler: ((child: RegisteredChild) => void) | null = null

  /**
   * Fixed-period agent-readiness snapshot sweep (D8 reconcile) — repairs
   * agent-origin readiness deltas lost while the agent stayed connected.
   * Not a retry backoff: a steady-state reconcile against each agent's
   * authoritative snapshot.
   */
  private static readonly AGENT_READINESS_PULL_INTERVAL_MS = 60_000

  private agentReadinessPullTimer: ReturnType<typeof setInterval> | null = null
  private readonly nodeCallFns = new Map<string, CallFn>()
  /**
   * D3: callback invoked whenever a bare-ID agent node completes the
   * `$hub.registerNode` handshake. Registered by `AgentRegistryService`
   * via `setOnAgentRegistered()`. The handshake is the authoritative
   * completeness signal — the hub has the full manifest at this point
   * and reconciliation can run immediately (no grace delay needed).
   */
  private onAgentRegisteredCb: ((nodeId: string) => void) | null = null
  /**
   * Hub-side authoritative readiness registry. Subscribed to the
   * shared `EventBusService` so it ingests both hub-local emits and
   * remote emits forwarded via `$hub.event`. Exposed to:
   *  - the `$readiness.getSnapshot` Moleculer action (consumed by
   *    workers / agents on boot)
   *  - `ctx.kernel.readinessRegistry` on every hub addon context so
   *    hub consumers share the same snapshot.
   */
  readonly readinessRegistry: ReadinessRegistry
  /**
   * UDS server that listens for addon-runners spawned by this hub node.
   * `null` when the UDS server failed to start (children run broker-only).
   */
  private localChildRegistry: LocalChildRegistry | null = null
  /**
   * Tracks cap names already logged as UDS-routed to avoid log spam.
   * Cleared on no external event — one INFO line per distinct capName
   * across the lifetime of the process.
   */
  private readonly udsRoutedCaps = new Set<string>()
  /**
   * CapRouteResolver — the single authority for cap dispatch routing.
   * Constructed at the end of onModuleInit, once `localChildRegistry` is
   * available and the broker has started. All cap dispatch flows through this.
   */
  private resolver: CapRouteResolver | null = null
  /**
   * Disposer returned by `createUdsEventBridge`. Called in `onModuleDestroy`
   * to unsubscribe the bridge from the parent bus and clear the child-event
   * handler, preventing subscriber leaks on shutdown.
   */
  private udsEventBridgeDispose: (() => void) | null = null

  /**
   * addonId → runner/child id resolver, injected late by
   * `AddonRegistryService` (which owns the addon declarations). Lets the UDS
   * `LocalChildRegistry` map the operator's active-singleton preference (an
   * addonId) onto a candidate CHILD id — a grouped addon's child id is its
   * `execution.group`, not its own id. Read live so a manifest change takes
   * effect without rebuilding the registry. Null → identity (addonId ===
   * childId), the correct default for every ungrouped addon.
   */
  private runnerIdResolver: ((addonId: string) => string) | null = null

  /**
   * Late-wire the addonId → runner-id resolver used by the UDS singleton
   * preference. Called once by `AddonRegistryService` during boot.
   */
  setRunnerIdResolver(resolver: (addonId: string) => string): void {
    this.runnerIdResolver = resolver
  }

  /**
   * Does `nodeId` (an agent) host the runner `runnerId`? Read from what the
   * node itself registered: its manifest names the addons it runs, and an
   * addon's runner is its `execution.group` or itself. A node that never
   * registered hosts nothing.
   */
  private isRunnerOnNode(nodeId: string, runnerId: string): boolean {
    const nodes = this.nodeRegistry
      .listNodeIds()
      .filter((id) => id === nodeId || id.startsWith(`${nodeId}/`))
    if (nodes.includes(`${nodeId}/${runnerId}`)) return true
    for (const id of nodes) {
      for (const entry of this.nodeRegistry.getNodeManifest(id) ?? []) {
        const runner = this.runnerIdResolver?.(entry.addonId) ?? entry.addonId
        if (entry.addonId === runnerId || runner === runnerId) return true
      }
    }
    return false
  }

  get childRegistry(): LocalChildRegistry | null {
    return this.localChildRegistry
  }

  /**
   * Register the (single) handler for a child's described custom-action
   * catalogs. See {@link childCustomActionsHandler}. Called once by
   * `AddonRegistryService` when it wires its consumers.
   */
  onChildCustomActions(handler: (child: RegisteredChild) => void): void {
    this.childCustomActionsHandler = handler
  }

  /** The CapRouteResolver once onModuleInit has completed; null before that. */
  get capRouteResolver(): CapRouteResolver | null {
    return this.resolver
  }

  /** This hub's Moleculer node id (e.g. `hub`). Hub-local forked children
   *  register under `${nodeId}/${runnerId}`. */
  get nodeId(): string {
    return this.broker.nodeID
  }

  constructor(
    private readonly eventBus: EventBusService,
    private readonly config: ConfigService,
    private readonly logging: LoggingService,
    private readonly capabilityService: CapabilityService,
    private readonly streamProbe: StreamProbeService,
  ) {
    this.logger = this.logging.createLogger('moleculer')
    // Optional port overrides. Live primarily for the e2e harness: when
    // a developer's dev:full is up on the default 6000 port, an
    // isolated test hub can't reuse it. Production keeps the default so
    // agent-to-hub connections keep working without per-deploy config.
    const tcpPortEnv = process.env['CAMSTACK_HUB_TCP_PORT']
    const tcpPort = tcpPortEnv ? Number(tcpPortEnv) : undefined
    // Two-step cast: createBroker's dist `.d.ts` chains through
    // moleculer→eventemitter2 whose types are unresolvable at this
    // boundary, so the inference falls to `error` and trips
    // `no-unsafe-assignment`. Going via `unknown` documents the boundary.
    // No shared secret (D857): the Moleculer namespace was never authentication (TCP
    // ignores it); a node is admitted by the certificate it presented at the TLS handshake.
    this.meshGuard = new HubMeshGuard('hub', this.logging.createLogger('mesh-auth'))
    const broker = createBroker({
      nodeID: 'hub',
      mode: 'hub',
      // D802, D857: every action and event another node sends passes the certificate gate.
      middlewares: [this.meshGuard.middleware()],
      logLevel: this.config.get<string>('moleculer.logLevel') ?? 'warn',
      ...(tcpPort && !Number.isNaN(tcpPort) ? { tcpPort } : {}),
    }) as unknown
    // `ServiceBroker` itself surfaces as `error`-typed at this boundary
    // (eventemitter2 chain unresolvable). Documented + single-site cast.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    this.broker = broker as ServiceBroker
    this.readinessRegistry = new ReadinessRegistry({
      eventBus: this.eventBus,
      sourceNodeId: this.broker.nodeID,
      logger: this.logging.createLogger('readiness'),
    })
  }

  /**
   * D3: register the callback that fires when an agent node completes the
   * `$hub.registerNode` handshake. Called by `AgentRegistryService` during
   * its own `onModuleInit` — after `MoleculerService.onModuleInit` has
   * returned, so the broker is already live. Option (b) direct-callback
   * wiring: no event-bus round-trip needed for internal core wiring.
   */
  setOnAgentRegistered(cb: (nodeId: string) => void): void {
    this.onAgentRegisteredCb = cb
  }

  async onModuleInit(): Promise<void> {
    const logger = this.logging.createLogger('moleculer')

    const hubDeps: HubServiceDeps = {
      // Through the settings door, three-way (D675): the stored record, `{}`
      // when the store answered with none, a THROW when it could not be read.
      // The sync `getAddonConfig` has no backend on an isolated engine and
      // answered `{}` for every addon.
      getAddonConfig: (addonId) => this.config.readAddonGlobalStrict(addonId),
      // `ConfigManager.get` REFUSES (throws) a key the isolated engine may hold
      // but cannot read synchronously (D675) — the caller gets that error over
      // Moleculer rather than a default dressed as the stored value.
      getSettings: (scope, key) => {
        return this.config.get(key ? `${scope}.${key}` : scope)
      },
      getRecentEvents: (category, limit) => {
        return this.eventBus.getRecent(category ? { category } : undefined, limit)
      },
      onLog: (entry) => {
        this.logging.writeFromWorker({
          addonId: entry.addonId,
          nodeId: entry.nodeId,
          level: entry.level,
          message: entry.message,
          ...(entry.scope !== undefined ? { scope: entry.scope } : {}),
          ...(entry.tags ? { tags: entry.tags } : {}),
          ...(entry.meta ? { meta: entry.meta } : {}),
        })
      },
      onSetLogLevel: (level) => {
        const factory = this.broker.logger
        const moleculerLogFactory = factory as MoleculerLogFactory
        const appenders = moleculerLogFactory.appenders
        if (appenders) {
          for (const appender of appenders) {
            appender.opts.level = level
          }
        }
        const cache = moleculerLogFactory.cache
        if (cache) {
          cache.clear()
        }
        logger.info('Moleculer log level changed', { meta: { level } })
        this.broker.call('$process.setLogLevel', { level }).catch(() => {})
      },
      // D3: registration-handshake path. Nodes send $hub.registerNode with
      // their complete capability manifest; the hub applies it immediately.
      onRegisterNode: (params) => {
        this.onRegisterNode(params)
      },
      onUnregisterNode: (nodeId) => {
        this.removeNodeFromRegistry(nodeId)
      },
      // The ack carries the hub's closure version so an agent aligns to it (agent self-update).
      getServerVersion: () => readHubServerVersion(),
      // D857: a node registers only itself, and only with a certificate identity.
      meshIdentity: this.meshGuard.gate,
    }

    const hubService: ServiceSchema = createHubService(hubDeps)
    this.broker.createService(hubService)

    // Forked addon-runner children must root their storage (addons-data,
    // the sqlite settings DB) under the SAME data path as the hub's main
    // process. The configured key is `server.dataPath` (populated from the
    // CAMSTACK_DATA env var); reading the non-existent `dataDir` key here
    // made every child silently fall back to the relative `camstack-data`,
    // so the DB escaped the mounted data dir in container deployments.
    const dataDir = this.config.get<string>('server.dataPath') ?? 'camstack-data'

    // UDS local transport: the hub hosts a LocalChildRegistry so its
    // forked addon-runners route cap calls directly over a Unix-domain
    // socket instead of through Moleculer. The broker stays available as
    // the no-route fallback (remote agents + caps no local child owns).
    // If the registry fails to start, children transparently fall back to
    // broker-only — no parentUdsPath is propagated.
    let parentUdsPath: string | undefined
    try {
      const nodeId = this.broker.nodeID
      // F0 (slice-5 outbound): when a forked child issues `ctx.api.<cap>` for a
      // cap NO local sibling owns, route it from the PARENT and return the
      // result over UDS — resolver-first, broker-fallback. Closes over `this`
      // so it reads `this.resolver` at CALL time (the resolver is constructed
      // later in onModuleInit, after broker.start()). The broker fallback
      // reaches the hub's core `$`-infra services (`$core-caps`, `$stream-probe`,
      // settings-store, …) that are Moleculer services, NOT registered
      // capabilities the resolver can see. Before F0 this fell through
      // UDS_NO_ROUTE → the child's own brokerTransportLink; F1+F2 removes that
      // child broker, so the parent must own this path.
      const onUnownedCall = createParentUnownedCallHandler({
        getResolver: () => this.resolver,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- moleculer types unresolvable; see `broker` getter docstring
        broker: this.broker,
        // Single capability authority — lets the broker fallback pin a
        // device-scoped call to its owning node instead of load-balancing it.
        nodeRegistry: this.nodeRegistry,
        // Hub-local UDS child dispatcher — routes a device-scoped native cap
        // owned by a hub-local child (reolink/hikvision cameras) directly over
        // UDS before any broker fallback. Getter: `this.localChildRegistry` is
        // assigned later in this method, after the handler is constructed.
        getLocalDispatcher: () => this.localChildRegistry,
        // Device-native signal for the registration-race recovery: a forked
        // child's device-native cap (e.g. `switch` on an export target) can be
        // briefly absent from the LocalChildRegistry just after a respawn. The
        // kernel layer has no cap registry, so feed it the `deviceNative` flag
        // from the cap definition. When true + binding-not-yet-registered, the
        // handler retries the hub-local route then throws a precise error rather
        // than the unroutable broker fallback (`switch.switch.getStatus`).
        isDeviceNativeCap: (capName) =>
          this.capabilityService.getRegistry()?.getDefinition(capName)?.deviceNative === true,
        // `native: true` route — a forked WRAPPER asking for the per-device
        // native behind its own cap name (the snapshot wrapper, once it moved
        // out of hub-main). `getNativeProvider` is the single authority that
        // can tell the two apart: in-process natives, hub-local vendor children
        // (via `setNativeFallback` → `resolveHubLocalUdsRoute`, which skips any
        // in-hub provider shadowing the name) and remote agents. Every other
        // route here resolves by cap name and would hand the wrapper back to
        // itself.
        resolveNative: (capName, deviceId) =>
          this.capabilityService
            .getRegistry()
            ?.getNativeProvider<Record<string, (input: unknown) => Promise<unknown>>>(
              capName,
              deviceId,
            ) ?? null,
        // `getStatus` of a CLAIMED cap (D663, S3) — the hub mirror answers a
        // forked child's `battery.getStatus({ deviceId })` (exporters, the
        // notification center) before the resolver would dispatch it to the
        // owning runner, whose `getStatus` is the native slice. The SAME
        // question the registry's resolvers ask, through the same method.
        claimedStatus: (capName, deviceId) => this.resolveClaimedStatus(capName, deviceId),
        // A covered device call the device's remote takes over (D963) — the
        // same question the registry's wrappers and the other entries ask.
        deviceCallRedirect: this.deviceCallRedirectHook(),
        // `nodeIdMode: 'data'` signal: for these caps (`addon-settings`,
        // `addons`, `nodes`, `pipeline-orchestrator`) an inline `args.nodeId`
        // is provider DATA — the hub singleton dispatches internally — never a
        // routing pin. Without this a forked child's call carrying `nodeId`
        // gets pinned to a node with no provider (dead broker fallback →
        // ServiceNotFoundError). The kernel layer has no cap registry, so feed
        // it the flag from the cap definition.
        isDataNodeIdCap: (capName) =>
          this.capabilityService.getRegistry()?.getDefinition(capName)?.nodeIdMode === 'data',
        // Empty-collection fast-path: a `collection` cap's array-output method
        // with ZERO providers registered cluster-wide IS the empty aggregate —
        // return [] instead of routing (resolver miss → broker fallback → ~30s
        // Moleculer discovery deadline for a service that never appears; this
        // stalled every WebRTC cold start via the provider-less `turn-provider`).
        // Conservative: only fires for a declared collection array-method with
        // no hub-local collection entries AND no cluster manifest entry.
        resolveEmptyCollection: (capName, method) => {
          const reg = this.capabilityService.getRegistry()
          if (!reg) return null
          if (reg.getDefinition(capName)?.mode !== 'collection') return null
          if (!COLLECTION_ARRAY_METHODS.get(capName)?.includes(method)) return null
          if (reg.getCollectionEntries(capName).length > 0) return null
          if (this.nodeRegistry.listEntries().some((e) => e.capName === capName)) return null
          return []
        },
        // Collection FAN-OUT for the same child→parent path: a collection
        // array-method answers with the union across every provider, exactly
        // as this server's tRPC cap-router does (shared code — the two must
        // never disagree again). Routing alone picks ONE provider, which is
        // how the Notification Center saw an empty `notification-output`
        // catalog and dead-lettered every notification (2026-07-30).
        callCollectionAggregate: (capName, method, args) =>
          aggregateCollectionCall(this.capabilityService.getRegistry(), capName, method, args),
        // `{ addonId }` PIN for the same child→parent path — the scalar twin of
        // the fan-out above, sharing this server's provider resolution so the
        // two paths cannot disagree. Routing takes only `nodeId`/`deviceId`, so
        // without this a forked addon's pin is discarded and the first
        // registered provider answers for a resource it does not own: HA's
        // export read Homematic's `null` for `ha_001` and never opened a link
        // (2026-08-09).
        //
        // The DEVICE twin runs first: `videoclips` mounts `device-scoped`
        // (scope+wrapper is checked before `mode`), so the global pin above
        // does not see it, and its pin is `provider`. Without this a forked
        // addon's clip byte read named `provider-reolink` and was answered by
        // whichever child registered first — the recorder, then export-hap
        // after a redeploy in a different order (2026-09-22, D594).
        callPinnedCollection: async (capName, method, args) =>
          (await pinnedDeviceCollectionCall(
            this.capabilityService.getRegistry(),
            capName,
            method,
            args,
          )) ?? pinnedCollectionCall(this.capabilityService.getRegistry(), capName, method, args),
        // Hub-core `$`-service discriminant for the general
        // provider-not-yet-registered recovery. A resolver miss on a NON-core
        // cap (any addon-provided system/singleton cap, e.g.
        // `pipeline-orchestrator`) means its broker-less forked provider hasn't
        // registered YET — the unpinned broker fallback is a dead path that
        // 30s-deadlines into `${cap}.${cap}.${method}`. Feeding the handler this
        // predicate lets it retry the resolver + throw a precise error instead.
        // Derived from the already-maintained core-router list, so a new
        // multi-node addon cap is covered with no change here.
        isCoreServiceCap: (capName) => isCoreServiceCapName(capName),
        logger: {
          debug: (msg, meta) =>
            logger.debug(
              msg,
              meta !== null && meta !== undefined
                ? { meta: meta as Record<string, unknown> }
                : undefined,
            ),
          warn: (msg, meta) =>
            logger.warn(
              msg,
              meta !== null && meta !== undefined
                ? { meta: meta as Record<string, unknown> }
                : undefined,
            ),
        },
      })
      // Symmetric inverse of `$agent-cap-fwd`: expose the hub's routing to
      // REMOTE agents. An agent's forked addon calling a hub-hosted cap
      // (`stream-broker`, `settings-store`, …) forwards to `$hub-cap-fwd.forward`,
      // which runs the call through THIS `onUnownedCall` (resolver + broker
      // fallback). Only the hub registers it, so an agent's undirected
      // `broker.call('$hub-cap-fwd.forward', …)` discovers it here. Without it a
      // remote agent's raw `${cap}.*` discovery 30s-deadlines (hub-local addon
      // runners expose no Moleculer service). See hub-cap-forward.ts.
      this.broker.createService(
        createHubCapForwardService(onUnownedCall, {
          // The agent stamps WHO is calling (its child's runner id) into the
          // envelope (D787). Believe it only when that runner is on the agent
          // the request came from — a node's registered manifest lists the
          // addons it hosts, and a grouped runner answers to its group id.
          isCallerOnNode: (senderNodeId, callerRunnerId) =>
            this.isRunnerOnNode(senderNodeId, callerRunnerId),
          onRejectedCaller: (senderNodeId, callerRunnerId) =>
            logger.warn('dropped an agent caller stamp the sender does not host', {
              meta: { senderNodeId, callerRunnerId },
            }),
        }),
      )
      const registry = new LocalChildRegistry({
        server: createLocalTransport().createServer(nodeId),
        // This node's own id — lets the cap-call-out router serve a pin-to-self
        // from the co-resident sibling instead of bouncing it through
        // onUnownedCall (a pin to ANOTHER node still bypasses the sibling).
        ownNodeId: nodeId,
        onUnownedCall,
        // A forked runner has no Moleculer broker, so `$node.connected` never
        // fires for it: the registry says `WorkerOnline` / `WorkerOffline`
        // `<hub>/<childId>` itself, on the hub's bus — WorkerOnline at the
        // pre-init register, before the child initializes (the D696 provider
        // gate forgets a provider there, before it can restore and seed).
        lifecycleEvents: { parentNodeId: () => nodeId, emit: (event) => this.eventBus.emit(event) },
        // `getStatus` of a CLAIMED cap is answered by the hub mirror BEFORE the
        // sibling short-circuit can dispatch it to the owning child (D663, S3)
        // — the same resolver the handler above and `callCapabilityOnNode` use.
        claimedStatus: (capName, deviceId) => this.resolveClaimedStatus(capName, deviceId),
        // The same device-call redirect, before the sibling short-circuit (D963).
        deviceCallRedirect: this.deviceCallRedirectHook(),
        // A collection ARRAY method must reach `onUnownedCall` (which fans it
        // across every provider) instead of being short-circuited to ONE local
        // sibling. Same predicate the aggregate itself uses, so the two agree
        // by construction.
        isAggregatedCollectionMethod: (capName, method) => {
          const reg = this.capabilityService.getRegistry()
          if (!reg) return false
          if (reg.getDefinition(capName)?.mode !== 'collection') return false
          return COLLECTION_ARRAY_METHODS.get(capName)?.includes(method) === true
        },
        // Same story for an explicit `{ addonId }` selector: the sibling
        // short-circuit picks the FIRST-registered child, which is precisely
        // what the selector exists to override. `onUnownedCall` then resolves
        // the named provider via `callPinnedCollection`. Shares `addonPinOf`
        // with it — the bypass and the routing must never disagree about what
        // counts as a pin, or the call is bounced out of the sibling path and
        // then routed by first-provider anyway.
        //
        // BOTH pins, because this predicate and `callPinnedCollection` must
        // agree about what counts as one. A pin the bypass does not recognise
        // is short-circuited to the first sibling and never reaches the
        // routing that would honour it — "honoured only there is honoured
        // never", which is how the first attempt at the `addonId` fix failed
        // live, and how the `provider` pin failed twice more (D592, D593).
        isAddonPinnedCall: (capName, method, args) =>
          addonPinOf(this.capabilityService.getRegistry(), capName, method, args) !== null ||
          devicePinOf(this.capabilityService.getRegistry(), capName, args) !== null,
        // Bound every UDS cap call by the cap's own declared timeout, falling
        // back to the channel default. Same resolver the REMOTE plane uses
        // below, so a method that survives 16 minutes across nodes survives it
        // across a socket too — and one that hangs is cut off on both.
        capTimeoutMs: (capName, method) =>
          this.capabilityService.getRegistry()?.getDefinition(capName)?.methods?.[method]
            ?.timeoutMs,
        // Feed the cap-usage graph from the one place that sees a forked
        // addon's outbound `ctx.api` traffic AND runs in the process that reads
        // it back (`nodes.getCapUsageGraph` → `cap-providers.ts`). The
        // runner-side observer in `addon-context-factory.ts` writes to the
        // RUNNER's own module singleton, which hub-main never sees — which is
        // why the graph answered `[]` on a hub running 64 addons. Blind spots
        // that remain are listed on `LocalChildRegistryOptions.capUsageObserver`.
        capUsageObserver: (obs) => getCapUsageRegistry().recordCall(obs),
        logger: {
          info: (msg, meta) =>
            logger.info(
              msg,
              meta !== null && meta !== undefined
                ? { meta: meta as Record<string, unknown> }
                : undefined,
            ),
        },
        // Hand the UDS-routing layer a view into the operator's
        // active-singleton preference. Without this, when two local
        // children own the same singleton cap (e.g. two `webrtc-session`
        // providers), routing returns
        // the first-registered child by insertion order — silently
        // bypassing `setActiveSingleton`. The closure reads the live
        // registry on every call so a runtime swap takes effect
        // immediately without rebuilding the resolver snapshot.
        getActiveSingletonAddonId: (capName: string): string | null =>
          this.capabilityService.getRegistry()?.getSingletonAddonId(capName) ?? null,
        // Map the preferred addonId to its runner CHILD id (group when the
        // addon declares `execution.group`, else its own id) so a grouped
        // addon stays selectable as the active singleton. Identity until
        // `AddonRegistryService` injects the resolver.
        resolveChildIdForAddon: (addonId: string): string =>
          this.runnerIdResolver?.(addonId) ?? addonId,
      })
      await registry.start()
      // E1: apply child manifest + cleanup from the UDS lifecycle (hub-local children).
      // When a runner connects over UDS, apply its cap descriptors to the
      // CapabilityRegistry — same effect as the `$hub.registerNode` RPC for
      // `hub/<runner>` nodes. This runs in PARALLEL with the RPC path until
      // Phase F removes the child broker; `onRegisterNode`'s diff logic ensures
      // double-apply is idempotent (same nodeId + same caps → no-op on the second call).
      registry.onChildRegistered((child) => {
        const hubNodeId = this.broker.nodeID
        const childNodeId = `${hubNodeId}/${child.childId}`
        // The catalogs first, and unconditionally: the manifest gate below
        // judges CAPS, and a frame whose caps are unchanged may still be the
        // one frame that describes the catalogs. An absent field is a pre-init
        // register and says nothing about actions — it is not forwarded.
        if (child.customActions !== undefined) {
          try {
            this.childCustomActionsHandler?.(child)
          } catch (err) {
            logger.warn('UDS child custom-action catalogs could not be applied', {
              meta: { nodeId: childNodeId, incarnation: child.incarnation, error: errMsg(err) },
            })
          }
        }
        const params = buildChildUdsManifest(childNodeId, child.childId, child.caps)
        // `updateCaps()` re-sends the whole register frame on the same socket,
        // so this fires far more often than a runner starts: 246 rebuilds in 30
        // minutes with zero respawns, measured live. A re-register that carries
        // the same incarnation AND the same manifest has nothing to apply — see
        // ChildManifestGate for why it takes both, and why skipping on either
        // one alone is wrong.
        if (!this.childManifestGate.shouldApply(child.childId, child.incarnation, params)) {
          if (this.childManifestGate.sampleDue()) {
            // INFO, not debug: the count IS the deliverable. A gate whose only
            // evidence sits below the production log level is a gate nobody can
            // tell apart from a child that stopped registering, and at one line
            // per CHILD_MANIFEST_SKIP_SAMPLE this is ~8 lines an hour at the
            // rate measured before the gate existed.
            logger.info('UDS child re-registered with an unchanged manifest — skipped', {
              meta: {
                nodeId: childNodeId,
                incarnation: child.incarnation,
                skipped: this.childManifestGate.skippedSince(),
                sampleEvery: CHILD_MANIFEST_SKIP_SAMPLE,
              },
            })
          }
          return
        }
        // The UDS connection is the only thing that can tell two generations of
        // the same runner apart — carry its incarnation into the registry as
        // the owner of every registration this manifest makes.
        this.onRegisterNode(params, childOwnerToken(childNodeId, child.incarnation))
        logger.info('UDS child registered — manifest applied', {
          meta: { nodeId: childNodeId, incarnation: child.incarnation },
        })
      })
      // E1: cleanup on child disconnect — same effect as `$node.disconnected`
      // for hub-local children. The Moleculer path stays for AGENT nodes.
      registry.onChildGone((childId, incarnation) => {
        const hubNodeId = this.broker.nodeID
        const childNodeId = `${hubNodeId}/${childId}`
        // The successor's first register must be a FIRST register: leaving the
        // record behind would let a same-incarnation reconnect (mixed-version
        // child, or a socket that came back) be skipped against a manifest the
        // registry no longer holds.
        this.childManifestGate.forget(childId)
        logger.info('UDS child gone — removing from registry', {
          meta: { childId, incarnation },
        })
        this.removeNodeFromRegistry(childNodeId, childOwnerToken(childNodeId, incarnation))
      })
      // B2: ingest UDS child logs into the hub's LoggingService so they appear
      // in the LogManager / admin-UI log stream alongside broker-forwarded logs.
      // This runs in PARALLEL with the existing $hub.log / onLog broker path —
      // both stay active until Phase F removes the broker path.
      registry.onChildLog((childId, entry) => {
        this.logging.writeFromWorker(udsChildLogToWorkerEntry(childId, entry))
      })
      // D1: answer readiness-snapshot requests from UDS children so they can
      // hydrate without a `$readiness.getSnapshot` Moleculer call.
      // `this.readinessRegistry` is the hub-authoritative instance subscribed
      // to the shared EventBusService — same source `$readiness.getSnapshot` uses.
      // The handler is a live closure (calls `getSnapshotForTransport()` on each
      // request) so children always receive the current snapshot, not a stale copy.
      // Keep `$readiness.getSnapshot` intact — Phase F removes it.
      registry.onReadinessSnapshotRequest(() => this.readinessRegistry.getSnapshotForTransport())
      this.localChildRegistry = registry
      parentUdsPath = localEndpointPath(nodeId)
      logger.info('UDS child registry listening', { meta: { path: parentUdsPath } })
    } catch (err) {
      logger.warn('UDS child registry failed to start; children stay broker-only', {
        meta: { err: err instanceof Error ? err.message : String(err) },
      })
    }

    const processService: ServiceSchema = createProcessService(
      this.broker.nodeID,
      dataDir,
      undefined,
      undefined,
      parentUdsPath,
    )
    this.broker.createService(processService)

    // $addonHost — REMOVED (Sprint 6). Three-level settings are now
    // served by the `addon-settings` singleton capability. Per-addon
    // Moleculer services expose `settings.*` actions for remote agents.

    // D3: mirror $node.disconnected onto the registry path so nodes that
    // sent a $hub.registerNode manifest get cleaned up on disconnect.
    this.broker.localBus.on('$node.disconnected', ({ node }: { node: { id: string } }) => {
      // No owner token: this listener cannot observe WHICH incarnation died.
      // For a hub-local child the UDS `onChildGone` is the authority (it holds
      // the incarnation) and this call is refused if the id has been reclaimed;
      // remote nodes register no owner at all, so they clean up as before.
      this.removeNodeFromRegistry(node.id)
      this.meshGuard.forget(node.id)
      // Release A: its next connection decides again whether it is `tls` or `clear`.
      getBrokerTlsTransporter(this.broker)?.forgetPeer(node.id)
    })

    // D8 reverse-leg snapshot-reconcile: on every agent (re)connect, pull
    // the agent's own readiness snapshot (`$agent-readiness.getSnapshot`)
    // and hydrate the hub-authoritative registry with the records the
    // agent is authoritative for. Cross-node `system.ready-state` deltas
    // are telemetry (lossy) — a lost post-restart `ready` used to leave
    // this registry stuck on the synthesized `down` forever (2026-07-17:
    // pipeline-executor@agent-a, 3.5h dispatch outage). The
    // periodic sweep below repairs deltas lost while CONNECTED.
    this.broker.localBus.on('$node.connected', ({ node }: { node: { id: string } }) => {
      const nodeId = node.id
      if (nodeId === this.broker.nodeID || nodeId.includes('/')) return
      void this.pullAgentReadinessSnapshot(nodeId)
      // The hub may have dropped this agent's registration on a disconnect
      // only the hub saw (gossip, a failed write): ask it for its full set
      // (`agent-registration-request.ts`, 2026-10-14).
      void requestAgentRegistration(
        {
          call: (action, params, opts) => this.broker.call(action, params, opts),
          isRegistered: (id) => this.isNodeRegistered(id),
          warn: (message, id, meta) => this.logger.warn(message, { tags: { nodeId: id }, meta }),
          info: (message, id, meta) => this.logger.info(message, { tags: { nodeId: id }, meta }),
        },
        nodeId,
      )
    })
    this.agentReadinessPullTimer = setInterval(() => {
      for (const nodeId of this.nodeRegistry.listNodeIds()) {
        if (nodeId === this.broker.nodeID || nodeId.includes('/')) continue
        void this.pullAgentReadinessSnapshot(nodeId)
      }
    }, MoleculerService.AGENT_READINESS_PULL_INTERVAL_MS)
    if (typeof this.agentReadinessPullTimer.unref === 'function') {
      this.agentReadinessPullTimer.unref()
    }

    // Register the $event-bus service BEFORE broker.start(). Moleculer
    // announces service subscriptions to remote nodes only during discovery
    // handshake, not dynamically after post-start `createService()`.
    // Without this, cross-node broadcasts (camstack.evt.<category>) would
    // arrive unreliably for the first ~10s after each node joins.
    registerEventBusService(this.broker)

    // Register the hub-authoritative `$readiness.getSnapshot` service
    // BEFORE broker.start() so workers / agents see it in their initial
    // INFO packet — post-start `createService` calls propagate via
    // heartbeat (several seconds) and would force workers to poll.
    this.broker.createService(createReadinessServiceForRegistry(this.readinessRegistry))

    // Register the hub-authoritative `$stream-probe` service —
    // workers route RTSP probe + field-probe through this action when
    // the tRPC WSS link isn't available (default path for forked
    // workers). Keeps ffprobe + HTTP-reachability as a single
    // hub-side implementation; see `createStreamProbeBrokerService`
    // for the shape.
    this.broker.createService(
      createStreamProbeBrokerService({
        probe: (url, options) => this.streamProbe.probe(url, options),
        probeField: (key, value) => this.streamProbe.probeField(key, value),
      }),
    )

    // D826: when system-config's MeshCaKeeper becomes ready it offers hub leaf
    // material here; the transporter listens on mutual TLS only (:6443).
    setProcessMeshTlsEnabler(async (material) => {
      const tx = getBrokerTlsTransporter(this.broker)
      if (tx === null) {
        logger.warn('Mesh TLS material ready but broker transporter is not TlsTcpTransporter')
        return
      }
      await tx.enableMeshTls(material)
      logger.info('Mesh mTLS listener enabled (TLS-only hub mesh)')
    })

    setProcessMeshPeerTransportLookup({
      transportOf: (nodeId) => getBrokerTlsTransporter(this.broker)?.peerTransport(nodeId),
      isVerifiedPeer: (nodeId) =>
        getBrokerTlsTransporter(this.broker)?.verifiedPeer(nodeId) !== undefined,
      peerLeaf: (nodeId) => getBrokerTlsTransporter(this.broker)?.peerLeaf(nodeId),
      dropPeer: (nodeId) => getBrokerTlsTransporter(this.broker)?.dropPeer(nodeId) ?? 0,
    })

    await this.broker.start()
    logger.info('Moleculer broker started (TCP transport)')

    // Construct the CapRouteResolver now that both the broker and
    // localChildRegistry are ready. The resolver reads live registry state
    // via closure accessors on every call (not a frozen snapshot), so new
    // children connecting/disconnecting after this point are picked up
    // correctly. The localChildRegistry reference is captured and may be
    // null if UDS failed to start.
    this.resolver = new CapRouteResolver({
      hubNodeId: this.broker.nodeID,
      broker: this.broker,
      hubLocalRegistry: this.localChildRegistry,
      nodeAuthority: createNodeCapAuthority(this.nodeRegistry, {
        resolveSingleton: (capName, nodeId) =>
          this.capabilityService.getRegistry()?.resolveSingletonAddonIdForNode(capName, nodeId) ??
          null,
      }),
      inProcessProviders: createInProcessProviderLookup(this.capabilityService),
      // Node-accurate lookup for EXPLICITLY hub-pinned calls: unlike the
      // lookup above (which falls back to the cluster-elected ACTIVE
      // singleton — possibly a remote proxy), this resolves only providers
      // physically resident on the hub, so a `nodePin('hub')` fails precisely
      // instead of silently executing on another node.
      hubResidentProviders: createHubResidentProviderLookup(this.capabilityService),
      // Per-cap-method RPC timeout override (e.g. model-convert.convert, which
      // runs for minutes) — read from the cap definition's declared timeoutMs.
      capTimeoutMs: (capName, method) =>
        this.capabilityService.getRegistry()?.getDefinition(capName)?.methods?.[method]?.timeoutMs,
    })

    // Wire the hub's EventBusService into the broker so hub-addon
    // emissions fan out to every remote process via
    // `camstack.evt.<category>`, and incoming $event-bus events land on
    // the same local bus that subscribers already use. The
    // EventBusService's `emit` override handles the "only broadcast
    // locally-originated events" guard, and id-based dedup absorbs the
    // duplicate delivery when `createBrokerEventBus` on a remote uses
    // both broadcast + `$hub.event` for back-compat.
    this.eventBus.attachBroker(this.broker)

    // C2: wire the UDS ↔ Moleculer event bridge so events emitted by UDS
    // children fan to siblings and reach the cluster, and cluster / parent-
    // local events propagate to every UDS child. Inert when no children
    // are connected (bridge just adds a no-op bus subscriber). The bridge
    // is wired after attachBroker so the parentBus is backed by the real
    // shared broker bus and broker.broadcast is live.
    if (this.localChildRegistry !== null) {
      const hubNodeId = this.broker.nodeID
      this.udsEventBridgeDispose = createUdsEventBridge({
        registry: this.localChildRegistry,
        parentBus: this.eventBus,
        parentNodeId: hubNodeId,
        // D2: relay via pass-through so the bridge's wildcard is not counted as
        // local interest (uniform with the agent; harmless here since the hub
        // retains and always accepts inbound cross-node events anyway).
        subscribePassthrough: (handler) => subscribePassthrough(this.broker, handler),
      })
      // D2: expose the hub's aggregate child interest to its `$event-bus`
      // inbound gate for uniformity with the agent. NOTE: the hub main process
      // opts into `retainRecent` (it serves `getRecent` + the admin-ui live
      // event stream), so `crossNodeAcceptsCategory` always accepts every
      // inbound category here — the hub never filters agent-origin events. This
      // wiring is therefore harmless-but-uniform; the real efficiency win is on
      // agents (non-retaining nodes).
      const hubChildRegistry = this.localChildRegistry
      setNodeEventInterest(this.broker, () => hubChildRegistry.aggregateEventInterest())
      // Producer-side suppression (D8): tell each forked child which categories
      // someone else wants — siblings plus the hub's own in-process subscribers
      // (the admin live stream is one) — so a high-frequency category nobody
      // wants never leaves its process. Hub only: an agent cannot see the hub's
      // subscribers, so its children keep sending everything. A remote node's
      // interest in a ring-denied category is NOT visible here (ADR 0969).
      hubChildRegistry.setEventInterestSource(() => getLocalEventInterest(this.broker))
      onLocalEventInterestChange(this.broker, () => hubChildRegistry.refreshEventInterest())
    }
  }

  /**
   * Register the log-receiver service for agent log forwarding.
   * Must be called AFTER app.init() so Moleculer re-advertises
   * the updated service list to the network.
   */
  registerLogReceiver(): void {
    this.broker.createService({
      name: 'log-receiver',
      actions: {
        ingest: {
          handler: (ctx: {
            params: {
              level: string
              message: string
              addonId: string
              nodeId: string
              scope?: string
              tags?: import('@camstack/types').LogTags
              meta?: Record<string, unknown>
            }
          }) => {
            this.logging.writeFromWorker({
              addonId: ctx.params.addonId,
              nodeId: ctx.params.nodeId,
              level: ctx.params.level,
              message: ctx.params.message,
              ...(ctx.params.scope !== undefined ? { scope: ctx.params.scope } : {}),
              ...(ctx.params.tags ? { tags: ctx.params.tags } : {}),
              ...(ctx.params.meta ? { meta: ctx.params.meta } : {}),
            })
            return true
          },
        },
      },
    })
  }

  /**
   * Register the `$core-caps` Moleculer service that bridges the hub's
   * core (non-addon) tRPC routers onto the cluster mesh.
   *
   * Called from `main.ts` after the appRouter is built — that happens
   * after `app.init()`, so the broker is already started. Post-start
   * `createService` is fine: the service propagates to remote nodes via
   * heartbeat and `brokerTransportLink` polls discovery, so forked
   * addons and late-joining agents still resolve `ctx.api.<coreCap>`.
   * `registerLogReceiver` relies on the same post-init registration.
   */
  registerCoreCapService(service: ServiceSchema): void {
    this.broker.createService(service)
  }

  /**
   * The hub's claim authority (D663, S3): `CapabilityRegistry.resolveClaimedStatus`,
   * which resolves the device's claims first. Every entry that routes a
   * device-scoped `getStatus` by name asks it through `answerClaimedGetStatus`.
   */
  private resolveClaimedStatus(capName: string, deviceId: number): Promise<StatusOverlayAnswer> {
    const registry = this.capabilityService.getRegistry()
    return registry !== null
      ? registry.resolveClaimedStatus(capName, deviceId)
      : Promise.resolve(UNCLAIMED)
  }

  /**
   * The device-call redirect (D963): `CapabilityRegistry.coversDeviceCall` /
   * `redirectDeviceCall`, resolved at CALL time so a redirect installed after
   * this entry was wired (core-blocks boots later) is honoured. Every entry
   * that routes a device-scoped call by name asks it through
   * `answerDeviceCallRedirect`.
   */
  private deviceCallRedirectHook(): DeviceCallRedirectHook {
    return {
      covers: (capName, method) =>
        this.capabilityService.getRegistry()?.coversDeviceCall(capName, method) === true,
      attempt: async (call) =>
        (await this.capabilityService.getRegistry()?.redirectDeviceCall(call)) ?? {
          kind: 'not-redirected',
        },
    }
  }

  /**
   * Call a capability method on a specific node.
   *
   * Delegates all routing decisions to the CapRouteResolver, which classifies
   * the (capName, nodeId) pair into a typed CapRoute and dispatches to the
   * appropriate transport (hub-in-process, hub-local-uds, remote-moleculer,
   * agent-child-forward). A genuinely-absent cap throws CapRouteError (typed,
   * with reason + rejected routes) instead of the old opaque error string.
   *
   * Falls back to the legacy findCallFn path when the resolver is not yet
   * constructed (before onModuleInit completes) or when the resolver throws a
   * no-provider / node-offline error for a node that IS in nodeCallFns — this
   * handles the window between registerNode applying a callFn and the resolver
   * seeing the new node (the resolver reads live registry state via closure
   * accessors, but nodeCallFns is populated by applyNodeManifest which may
   * have run before the resolver was constructed).
   */
  async callCapabilityOnNode(
    nodeId: string,
    capabilityName: string,
    methodName: string,
    params: unknown,
  ): Promise<unknown> {
    // `getStatus` of a CLAIMED cap — the hub mirror answers (D663, S3). This is
    // the third entry that resolves a cap call by name (the hub's own tRPC with
    // a `nodeId` pin — the generated DeviceProxy always sends one — and every
    // hub in-process addon's `ctx.api` through `deviceCapResolverLink`); a pin
    // does not bypass the claim authority. Same shared function as the other two.
    const claimed = await answerClaimedGetStatus(
      (capName, deviceId) => this.resolveClaimedStatus(capName, deviceId),
      { capName: capabilityName, method: methodName, args: params },
    )
    if (claimed !== null) return claimed.slice
    // A covered device call the device's remote takes over (D963): the hub's
    // own tRPC and every in-process `ctx.api` call arrive here with a pin.
    const redirected = await answerDeviceCallRedirect(this.deviceCallRedirectHook(), {
      capName: capabilityName,
      method: methodName,
      args: params,
    })
    if (redirected !== null) return redirected.result
    const resolver = this.resolver
    if (resolver !== null) {
      // Extract deviceId from params so device-scoped native caps (ptz, motion-zones, …)
      // resolve through the resolver's deviceId-aware snapshot instead of falling back to
      // the legacy callFn store. The deviceId hint is a number extracted from the method args.
      const rawDeviceId: unknown =
        params !== null && typeof params === 'object' ? Reflect.get(params, 'deviceId') : undefined
      const routeDeviceId: number | undefined =
        typeof rawDeviceId === 'number' ? rawDeviceId : undefined
      try {
        const route = resolver.resolveCapRoute(capabilityName, { nodeId, deviceId: routeDeviceId })
        return await resolver.dispatch(route, methodName, params)
      } catch (err) {
        if (
          err instanceof CapRouteError &&
          (err.reason === 'no-provider' || err.reason === 'node-offline')
        ) {
          // Resolver couldn't find the cap — try the legacy callFn store as a
          // fallback. This covers caps registered in nodeCallFns (e.g. agent
          // nodes that registered before the resolver's snapshot was built or
          // caps that the resolver's nodeAuthority doesn't see yet because the
          // resolver reads live registry state via closure accessors).
          // Device-scoped native caps now resolve via the resolver (M1/M5 thread deviceId),
          // so this fallback only handles genuinely-transitional stale-snapshot windows.
          const callFn = this.findCallFn(nodeId, capabilityName)
          if (callFn !== undefined) {
            return callFn(methodName, params)
          }
        }
        // Rethrow — includes transport-failed and all other errors
        throw err
      }
    }

    // Pre-init fallback (resolver not yet constructed — before onModuleInit).
    // This path is only reachable in tests that drive onRegisterNode without
    // calling onModuleInit first.
    if (nodeId === 'hub' || nodeId === this.broker.nodeID) {
      const registry = this.capabilityService.getRegistry()
      const provider = registry?.getSingleton<Record<string, unknown>>(capabilityName) ?? null
      if (provider !== null) {
        const fn = provider[methodName]
        if (typeof fn !== 'function')
          throw new Error(`Method "${methodName}" not found on "${capabilityName}"`)
        return fn.call(provider, params)
      }
    }

    const callFn = this.findCallFn(nodeId, capabilityName)
    if (callFn) {
      return callFn(methodName, params)
    }

    throw new CapRouteError(capabilityName, methodName, {
      reason: 'no-provider',
      nodeId,
      rejected: [
        { kind: 'hub-in-process', why: 'CapRouteResolver not initialised (pre-onModuleInit)' },
      ],
    })
  }

  /**
   * D3 registration-handshake entrypoint — invoked by the `$hub.registerNode`
   * Moleculer action (wired through `hubDeps.onRegisterNode`).
   *
   * Captures the node's PREVIOUS manifest before `nodeRegistry.registerNode`
   * overwrites it, then hands both manifests to `applyNodeManifest` so the
   * CapabilityRegistry update is a diff (atomic replace) rather than an
   * unconditional re-register — see `applyNodeManifest` for the rationale.
   */
  private onRegisterNode(params: RegisterNodeParams, owner?: ProviderOwnerToken): void {
    const previousManifest = this.nodeRegistry.getNodeManifest(params.nodeId)
    const previousOwner = this.nodeOwners.get(params.nodeId)
    this.nodeRegistry.registerNode(params)
    if (owner === undefined) this.nodeOwners.delete(params.nodeId)
    else this.nodeOwners.set(params.nodeId, owner)
    this.applyNodeManifest(params, previousManifest, owner, previousOwner)
    // The leaf this node presents NOW is recorded, and a renewal leaf it no longer presents (it
    // reverted to its previous one) is set aside at once.
    this.observePresentedMeshLeaf(params.nodeId)
    // The node's capabilities are routable now: whoever waits for this registration (a mesh
    // leaf renewal confirming the node came back WITH the new leaf) is told, with no polling.
    emitProcessNodeRegistered(
      params.nodeId,
      params.addons.map((addon) => addon.addonId),
    )
    // Notify AgentRegistryService to reconcile placement for bare-ID
    // agent nodes (no '/' = not a hub child worker, not the hub itself).
    // The handshake is the authoritative completeness signal — the full
    // manifest is available here so reconciliation runs without delay.
    const { nodeId } = params
    if (nodeId !== 'hub' && !nodeId.includes('/') && this.onAgentRegisteredCb) {
      this.onAgentRegisteredCb(nodeId)
    }
  }

  /**
   * D3: apply a node's registered manifest onto the CapabilityRegistry.
   * Builds a method proxy for each capability — same registryKey rule
   * (local child → bare addonId, remote agent → addonId@nodeId), same
   * `broker.call` routing shape, same `expandCapMethods` method surface.
   *
   * Called from `onRegisterNode` whenever a node handshakes.
   *
   * Diff-based / idempotent: the D3 protocol legitimately re-handshakes (a
   * node re-sends its COMPLETE manifest — e.g. the post-device-restore
   * `nativeCaps` re-handshake). `registerProvider` throws on a duplicate
   * `(cap, addonId)` pair, so a blind re-register would throw on every
   * re-handshake and trip the registering node's retry loop into a storm.
   * Instead this diffs the NEW manifest against `previousManifest`:
   * unchanged caps are left untouched, dropped caps are unregistered, new
   * caps are registered. This honours the invariant "`registerNode`
   * replaces the node's entire cap set atomically".
   *
   * NOTE: `params.nativeCaps` is stored by `nodeRegistry.registerNode()`
   * already; this method handles only `params.addons` (system caps).
   * Native-cap wiring into device-manager is done in a later task.
   */
  private applyNodeManifest(
    params: RegisterNodeParams,
    previousManifest?: readonly RegisteredAddonManifest[],
    owner?: ProviderOwnerToken,
    previousOwner?: ProviderOwnerToken,
  ): void {
    const { nodeId, addons } = params
    const hubNodeId = this.broker.nodeID
    const isLocalChild = nodeId.startsWith(hubNodeId + '/')
    const isHubInProcess = nodeId === hubNodeId

    // Hub in-process addons register themselves during initialize() — skip.
    if (isHubInProcess) return

    const registry = this.capabilityService.getRegistry()
    if (!registry) return

    // Same registryKey rule as CapabilityBridge / onProviderConnected:
    //   local child → bare addonId (one instance per forked child)
    //   remote agent → addonId@nodeId (unique per agent node)
    // `nodeId` is identical for the previous and new manifest (same node
    // re-handshaking), so the rule resolves the same key on both sides.
    const registryKeyFor = (addonId: string): string =>
      isLocalChild ? addonId : `${addonId}@${nodeId}`

    // Collect the `(registryKey, capName)` pairs a manifest would APPLY —
    // applying the SAME infra skip and `capDef` existence check the
    // register block below uses, so the set reflects exactly what is
    // (or would have been) registered. Keyed `${registryKey}::${capName}`.
    // The resolved `capDef` is carried through so the register loop never
    // re-looks it up (and never needs a non-null assertion).
    //
    // Infra caps (`data-store-provider`, `storage-provider`, …) used to be
    // skipped for EVERY handshake. That was right for a remote agent — the
    // hub collection is this node's engine, and a second sqlite would make
    // the door refuse (D44). It is wrong for a hub-local child: sqlite-settings
    // isolate (D231) IS this node's engine, and skipping it leaves
    // `getCollection` empty. Hub-local children are proxied; remote nodes
    // are not (D233).
    const skipInfraFromRemote = (capName: string): boolean =>
      isInfraCapability(capName) && !isLocalChild
    const appliedKeys = (
      manifest: readonly RegisteredAddonManifest[],
    ): Map<string, AppliedCapEntry> => {
      const keys = new Map<string, AppliedCapEntry>()
      for (const addon of manifest) {
        const registryKey = registryKeyFor(addon.addonId)
        for (const capName of addon.capabilities) {
          if (skipInfraFromRemote(capName)) continue
          const capDef = registry.getDefinition(capName)
          if (!capDef) continue
          keys.set(`${registryKey}::${capName}`, { addonId: addon.addonId, capName, capDef })
        }
      }
      return keys
    }

    const desired = appliedKeys(addons)
    const previous = appliedKeys(previousManifest ?? [])

    // ── UNREGISTER ── caps the previous manifest applied but the new one
    // does not. Quiet — readiness is driven by `$node.connected/disconnected`,
    // not by a re-handshake, so no readiness events here.
    for (const [key, { addonId, capName }] of previous) {
      if (desired.has(key)) continue
      // Present the token the DROPPED registration was made under — this node
      // is dropping its own cap, and the registry refuses anything else.
      registry.unregisterProvider(capName, registryKeyFor(addonId), previousOwner)
      this.nodeCallFns.delete(`${nodeId}::${capName}`)
    }

    // ── TAKE OVER ── caps present in BOTH manifests when the node id has been
    // reclaimed by a NEW incarnation. The registration is correct and stays
    // (zero churn), but it is still stamped with the dead generation's token —
    // leave it there and nothing the live generation can present would ever
    // clean it up when IT dies. Re-stamp instead.
    if (owner !== undefined && previousOwner !== undefined && owner !== previousOwner) {
      for (const [key, { addonId, capName }] of desired) {
        if (!previous.has(key)) continue
        registry.reassignProviderOwner(capName, registryKeyFor(addonId), owner)
      }
    }

    // ── REGISTER ── caps the new manifest applies that the previous one
    // did not. Caps present in BOTH sets are left untouched — zero churn,
    // no duplicate `registerProvider`, no spurious page/widget re-emit.
    for (const [key, { addonId, capName, capDef }] of desired) {
      if (previous.has(key)) continue

      const registryKey = registryKeyFor(addonId)

      // The runner id (= UDS childId) for a hub-local forked child is the
      // trailing segment of its nodeId `${hubNodeId}/${runnerId}`. Only
      // hub-local children are reachable over UDS; agent-hosted providers
      // (`<agent>/<runner>`) fall through to Moleculer.
      const udsChildId = isLocalChild ? nodeId.slice(hubNodeId.length + 1) : null

      // Per-(cap,node) dispatcher. Routing lives in the unit-tested
      // `buildCapCallFn` (see cap-call-fn.ts):
      //   - hub-local child → per-child UDS (collection-safe; keyed by runner
      //     id, never by capName which would collapse a COLLECTION cap onto
      //     the first child). Fails fast if the child isn't providing — NEVER
      //     a Moleculer fallback, since a hub-local child is not a Moleculer
      //     service (a broker call would hang the full discovery timeout).
      //   - agent-hosted / remote → the unified `CapRouteResolver`, which
      //     classifies an agent node as `agent-child-forward` (hub→agent→UDS
      //     child) and a direct remote as `remote-moleculer`. This closes the
      //     UDS-migration gap where this dispatcher hand-rolled a `broker.call`
      //     to an agent that exposes no Moleculer service for the cap.
      //   - resolver not yet built (pre-init) → legacy Moleculer call.
      const callFn: CallFn = buildCapCallFn({
        capName,
        addonId,
        nodeId,
        udsChildId,
        getLocalChildRegistry: () => this.localChildRegistry,
        getResolver: () => this.resolver,
        legacyBrokerCall: (method, methodParams, targetNode) =>
          callWithServiceDiscovery(
            this.broker,
            addonId,
            capActionName(addonId, capName, method, false),
            serializeTypedArrays(methodParams),
            { nodeID: targetNode, timeout: 60_000 },
          ),
        onUdsRoute: (cap) => {
          if (!this.udsRoutedCaps.has(cap)) {
            this.udsRoutedCaps.add(cap)
            this.logger.info('routing cap over UDS', { meta: { capName: cap } })
          }
        },
      })

      const proxy: Record<string, unknown> = { id: addonId, nodeId }
      for (const methodName of Object.keys(expandCapMethods(capDef))) {
        proxy[methodName] = (methodParams: unknown) => callFn(methodName, methodParams)
      }
      registry.registerProvider(capName, registryKey, proxy, owner)

      // Local-first singleton preference (UDS regression fix). A
      // `placement: 'any-node'` singleton (e.g. `pipeline-executor`) can
      // register on BOTH the hub-local forked child and a remote agent.
      // `CapabilityRegistry` keeps the FIRST-registered provider active, so a
      // race could leave the REMOTE agent proxy active — and its callFn routes
      // over Moleculer to a UDS-only agent runner that no longer hosts the
      // Moleculer service ("not found on <agent>"). The hub-local provider is
      // reachable over UDS, so prefer it whenever the current active is absent
      // or remote (`@`-keyed). Never steals from another local provider, so an
      // operator's binding choice (a bare-key local provider) is preserved.
      if (capDef.mode === 'singleton' && isLocalChild) {
        const activeKey = registry.getSingletonAddonId(capName)
        if (activeKey === null || activeKey.includes('@')) {
          registry.setSingletonActiveAddon(capName, registryKey)
        }
      }

      // Emit AddonPageReady / AddonWidgetReady so the admin-UI sidebar
      // refreshes its page/widget registry for cross-process addons.
      if (capName === 'addon-pages-source') {
        this.eventBus.emit({
          id: randomUUID(),
          timestamp: new Date(),
          source: { type: 'addon', id: addonId },
          category: EventCategory.AddonPageReady,
          data: { addonId, nodeId },
        })
      }
      if (capName === 'addon-widgets-source') {
        this.eventBus.emit({
          id: randomUUID(),
          timestamp: new Date(),
          source: { type: 'addon', id: addonId },
          category: EventCategory.AddonWidgetReady,
          data: { addonId, nodeId },
        })
      }

      // Store callFn so `callCapabilityOnNode` and `createCapabilityProxy`
      // can reach manifest-registered nodes.
      this.nodeCallFns.set(`${nodeId}::${capName}`, callFn)
    }
  }

  /**
   * D3: remove a node's manifest from the CapabilityRegistry on disconnect.
   * Unregisters every cap the node's last manifest declared and emits
   * synthetic readiness-down events for each.
   */
  private removeNodeFromRegistry(nodeId: string, owner?: ProviderOwnerToken): void {
    const currentOwner = this.nodeOwners.get(nodeId)
    if (currentOwner !== undefined && currentOwner !== owner) {
      // The node id has been reclaimed by a newer incarnation since this
      // teardown was scheduled. Tearing down here would unregister the LIVE
      // process's capabilities and remove a node that is still connected.
      this.logger.info('Node teardown ignored — node id reclaimed by a newer incarnation', {
        meta: { nodeId, currentOwner, presentedOwner: owner ?? null },
      })
      return
    }

    const manifest = this.nodeRegistry.getNodeManifest(nodeId)
    if (!manifest) return // node never sent a handshake — nothing to do

    const hubNodeId = this.broker.nodeID
    const isLocalChild = nodeId.startsWith(hubNodeId + '/')
    const disconnectGen = `disconnect-${nodeId}-${randomUUID()}`
    const agentNodeId = nodeId.includes('/') ? nodeId.split('/')[0]! : nodeId

    const registry = this.capabilityService.getRegistry()

    for (const addon of manifest) {
      const { addonId, capabilities } = addon
      const registryKey = isLocalChild ? addonId : `${addonId}@${nodeId}`

      if (registry) {
        for (const capName of capabilities) {
          registry.unregisterProvider(capName, registryKey, owner)
        }
      }

      for (const capName of capabilities) {
        this.nodeCallFns.delete(`${nodeId}::${capName}`)

        try {
          emitReadiness(this.eventBus, {
            capName,
            scope: { type: 'node', nodeId: agentNodeId },
            state: 'down',
            generation: disconnectGen,
            sourceNodeId: hubNodeId,
          })
        } catch (err) {
          this.logger.warn('Failed to emit synthetic readiness down', {
            tags: { addonId, nodeId },
            meta: { capName, err: err instanceof Error ? err.message : String(err) },
          })
        }
      }
    }

    this.nodeOwners.delete(nodeId)
    this.nodeRegistry.removeNode(nodeId)
  }

  private findCallFn(nodeId: string, capabilityName: string): CallFn | undefined {
    // Exact match first — direct hit when the caller knows the full
    // nodeId (e.g. `hub/detection-pipeline`) or when the cap is hosted
    // on a bare top-level node (remote agent with in-process addons).
    const direct = this.nodeCallFns.get(`${nodeId}::${capabilityName}`)
    if (direct) return direct
    // Prefix fallback: forkable addons register under
    // `<parent>/<processName>` (e.g. `dev-agent-0/detection-pipeline`).
    // UI callers typically pass the bare parent nodeId (`dev-agent-0`)
    // because that's what they get from AgentOnline events and the
    // orchestrator assignments. Resolve by finding any registered node
    // whose id starts with `<nodeId>/` and hosts the cap.
    const prefix = `${nodeId}/`
    for (const key of this.nodeCallFns.keys()) {
      const sep = key.lastIndexOf('::')
      if (sep < 0) continue
      const keyNode = key.slice(0, sep)
      const keyCap = key.slice(sep + 2)
      if (keyCap !== capabilityName) continue
      if (keyNode.startsWith(prefix)) return this.nodeCallFns.get(key)
    }
    return undefined
  }

  /**
   * Returns true when a (nodeId, capabilityName) pair is reachable via the
   * legacy fallback paths: either a stored callFn in nodeCallFns, or a
   * hub-local forked child that is reachable over UDS (even without a
   * manifest callFn — e.g. device-scoped native caps). Used by
   * createCapabilityProxy to decide whether to build a proxy when the
   * CapRouteResolver cannot find a route.
   */
  private isReachableViaLegacy(nodeId: string, capabilityName: string): boolean {
    if (this.findCallFn(nodeId, capabilityName) !== undefined) return true
    return this.localChildRegistry !== null && nodeId.startsWith(`${this.broker.nodeID}/`)
  }

  /**
   * Build a proxy object that forwards every method call on a capability
   * to the correct transport via CapRouteResolver. Returns null if the
   * capability is provably not reachable on that node (resolver says no-provider
   * AND no legacy callFn exists AND it is not a hub-local child).
   *
   * Used by the generated cap routers when a request includes a `nodeId` field
   * for transparent node routing.
   *
   * Hub-local forked children (e.g. `hub/provider-reolink`) are reachable over
   * UDS even when no manifest callFn exists — device-scoped NATIVE caps (ptz,
   * motion-zones) aren't in `applyNodeManifest`'s callFn store. The proxy is
   * built unconditionally for hub-local children so `callCapabilityOnNode` can
   * route the actual method call via the resolver's hub-local-uds branch.
   */
  createCapabilityProxy(
    capabilityName: string,
    nodeId: string,
  ): Record<string, (params: unknown) => Promise<unknown>> | null {
    const resolver = this.resolver
    if (resolver !== null) {
      // Use the resolver to determine reachability. If it resolves a route, we
      // can build a proxy. If it throws no-provider but a legacy callFn exists
      // or the node is a hub-local child (for native caps), build the proxy anyway
      // because callCapabilityOnNode's fallback will handle it at dispatch time.
      try {
        resolver.resolveCapRoute(capabilityName, { nodeId })
        // Resolver found a route — proxy is reachable.
      } catch (err) {
        if (
          err instanceof CapRouteError &&
          (err.reason === 'no-provider' || err.reason === 'node-offline')
        ) {
          // Check legacy callFn store and hub-local child fallbacks.
          if (!this.isReachableViaLegacy(nodeId, capabilityName)) return null
          // Proxy reachable via fallback paths — fall through to build it.
        } else {
          throw err
        }
      }
    } else {
      // Pre-init: use legacy reachability check.
      if (!this.isReachableViaLegacy(nodeId, capabilityName)) return null
    }

    // Build a dynamic proxy: every property access returns a function that
    // routes the call through callCapabilityOnNode (which delegates to the resolver).
    return new Proxy<Record<string, (params: unknown) => Promise<unknown>>>(
      {},
      {
        get: (_target, methodName: string) => {
          return (params: unknown): Promise<unknown> =>
            this.callCapabilityOnNode(nodeId, capabilityName, methodName, params)
        },
      },
    )
  }

  /**
   * D3 handshake-fed native-cap view of the whole cluster.
   * Returns every `(nodeId, addonId, capName, deviceId)` tuple stored by
   * `onRegisterNode` — updated atomically each time a node re-handshakes
   * (e.g. after device restore completes). Used by `device-manager.addon.ts`
   * as a reliable fallback when push-based `DeviceBindingsChanged` events
   * were lost in the Moleculer transport handshake window.
   *
   * NOT a Moleculer action — only the hub process calls this directly
   * through the `ctx.kernel.listClusterNativeCaps` injection.
   */
  listClusterNativeCaps(): readonly import('@camstack/system').NodeNativeCapEntry[] {
    return this.nodeRegistry.listNativeCapEntries()
  }

  /**
   * Per-device slice of {@link listClusterNativeCaps}, served from the
   * registry's `deviceId → entries` index — O(caps-for-device). Used by the
   * per-device `getBindings` hot path so `getAllBindings` doesn't flatten the
   * whole cluster once per device.
   */
  listClusterNativeCapsForDevice(
    deviceId: number,
  ): readonly import('@camstack/system').NodeNativeCapEntry[] {
    return this.nodeRegistry.listNativeCapEntriesForDevice(deviceId)
  }

  /**
   * Does the hub hold a capability registration for `nodeId`? `false` for an
   * agent that is online in the mesh but whose manifest was dropped (a
   * disconnect only the hub saw) and not yet re-sent — reported as such by
   * `nodes.topology` (`capabilitiesRegistered`), never silently capless.
   */
  isNodeRegistered(nodeId: string): boolean {
    return this.nodeRegistry.getNodeManifest(nodeId) !== undefined
  }

  /**
   * Record the mesh leaf `nodeId` presents on its live connection (D856). Fire and forget: a
   * registry that is not up, or a write that fails, must not fail the node's registration.
   */
  private observePresentedMeshLeaf(nodeId: string): void {
    const registry = getProcessMeshCertificateRegistry()
    const leaf = getProcessPeerLeaf(nodeId)
    if (registry === null || leaf === undefined) return
    registry
      .recordObserved(nodeId, {
        cn: nodeId,
        serial: leaf.serial,
        fingerprint: leaf.fingerprint,
        notBefore: leaf.notBefore,
        notAfter: leaf.notAfter,
      })
      .catch((error: unknown) => {
        this.logger.warn('Could not record the mesh leaf the node presents', {
          tags: { nodeId },
          meta: { error: error instanceof Error ? error.message : String(error) },
        })
      })
  }

  /** The addon ids a node's registration holds (its own and its children's); empty when none. */
  getNodeAddonIds(nodeId: string): readonly string[] {
    return (this.nodeRegistry.getNodeManifest(nodeId) ?? []).map((entry) => entry.addonId)
  }

  /**
   * The root-package identity a node reported in its `registerNode`
   * manifest (runtime-updatable node packages: version visibility), or null
   * when the node never reported one (UDS children, pre-phase-2 agents).
   */
  getNodeRootPackage(nodeId: string): import('@camstack/system').NodeRootPackageInfo | null {
    return this.nodeRegistry.getNodeRootPackage(nodeId)
  }

  /**
   * E2: Send a `set-log-level` UDS message to a hub-local child identified by
   * `nodeId` (e.g. `hub/provider-reolink`). Extracts the `childId` from the
   * nodeId and delegates to `LocalChildRegistry.setChildLogLevel`.
   *
   * Returns `true` only if the nodeId is a hub-local child (`hub/<childId}`) AND
   * the child is currently connected to the LocalChildRegistry (the UDS message
   * was emitted). Returns `false` when the nodeId is not a hub-local child, the
   * registry is absent, or the child is not yet/no longer connected — in all
   * three cases the caller (setProcessLogLevel in cap-providers.ts) falls back
   * to the Moleculer `$node-mgmt.setLogLevel` action.
   */
  setChildLogLevelByNodeId(nodeId: string, level: string): boolean {
    const hubNodeId = this.broker.nodeID
    if (!nodeId.startsWith(`${hubNodeId}/`)) return false
    const childId = nodeId.slice(hubNodeId.length + 1)
    const registry = this.localChildRegistry
    if (registry === null) return false
    return registry.setChildLogLevel(childId, level)
  }

  /**
   * Pull one agent's own readiness snapshot and hydrate the
   * hub-authoritative registry with the records that agent is
   * authoritative for (see `agent-readiness-pull.ts` for the filter
   * rationale). Best-effort: agents predating `$agent-readiness` (or a
   * service list still propagating right after connect) fail with
   * "not found" — silent; the periodic sweep retries.
   */
  private async pullAgentReadinessSnapshot(nodeId: string): Promise<void> {
    try {
      const snapshot = await this.broker.call(
        `${AGENT_READINESS_SERVICE_NAME}.getSnapshot`,
        {},
        { nodeID: nodeId },
      )
      if (!Array.isArray(snapshot) || snapshot.length === 0) return
      const records = filterAgentAuthoritativeRecords(snapshot, nodeId)
      if (records.length === 0) return
      this.readinessRegistry.hydrate(records)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes('not found') && !msg.includes('NOT_FOUND')) {
        this.logger.debug('agent readiness snapshot pull failed', {
          tags: { nodeId },
          meta: { err: msg },
        })
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    setProcessMeshTlsEnabler(null)
    setProcessMeshPeerTransportLookup(null)
    if (this.agentReadinessPullTimer !== null) {
      clearInterval(this.agentReadinessPullTimer)
      this.agentReadinessPullTimer = null
    }
    this.udsEventBridgeDispose?.()
    this.udsEventBridgeDispose = null
    await this.broker.stop()
    await this.localChildRegistry?.close()
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * The owner token a hub-local UDS child's capability registrations carry.
 *
 * `nodeId` alone is NOT an identity over time — a runner replaced by an addon
 * update reconnects under the same deterministic `hub/<runner>` id — so the
 * connection's incarnation is what makes the pair unique. Exported for the
 * regression suite: the rule is only worth anything if register and unregister
 * derive the token the SAME way.
 */
export function childOwnerToken(childNodeId: string, incarnation: number): ProviderOwnerToken {
  return `${childNodeId}#${incarnation}`
}

/**
 * One skipped-re-register line per this many skips.
 *
 * A gate nobody can count is indistinguishable from a child that stopped
 * re-registering, and those two want opposite investigations. A line per skip
 * would reproduce exactly the volume the gate exists to remove.
 */
export const CHILD_MANIFEST_SKIP_SAMPLE = 25

/**
 * The last manifest a child successfully applied, as the gate compares it.
 *
 * `fingerprint` is a canonical serialisation of the BUILT manifest, not of the
 * `ChildCapDescriptor[]` the child sent: `buildChildUdsManifest` drops
 * device-scoped caps and groups the rest by addon, so fingerprinting its INPUT
 * would let the gate disagree with what is actually applied the moment that
 * function changes.
 */
interface AppliedChildManifest {
  readonly incarnation: number
  readonly fingerprint: string
}

/** Canonical, order-insensitive text for a child manifest. */
function childManifestFingerprint(params: RegisterNodeParams): string {
  const addons = params.addons
    .map((addon) => `${addon.addonId}:${[...addon.capabilities].sort().join(',')}`)
    .sort()
  return `${params.nodeId}|${addons.join('|')}`
}

/**
 * Skips a child re-registration that carries nothing new.
 *
 * ## What it prevents
 *
 * `LocalChildClient.updateCaps()` re-sends the complete `register` frame on the
 * SAME socket whenever a child re-publishes its cap set. Measured on the live
 * hub 2026-08-25: **246 full manifest rebuilds in 30 minutes with zero runner
 * respawns**, every one carrying the same `incarnation` as the one before it
 * (provider-homeassistant alone: 70). `applyNodeManifest` is diff-based, so the
 * registry ends in the same state — the RESULT is idempotent, the WORK is not.
 * Each pass re-stores the manifest, builds two `appliedKeys` maps over every cap
 * of every hosted addon, and prints a line, on the one thread that also answers
 * every settings read, every UDS handshake and every cross-runner cap call
 * (D181).
 *
 * ## Why the key is BOTH incarnation and manifest
 *
 * Incarnation alone would skip a legitimate `updateCaps` — device-restore adds
 * device-scoped native caps on the same connection, which is the case the
 * re-register path was built for. Manifest alone would skip a RESPAWN that came
 * back with an identical cap set, and a respawn must always re-apply: the owner
 * token is `childOwnerToken(nodeId, incarnation)`, so skipping it would leave
 * every provider owned by the dead generation and the successor's disconnect
 * would unregister nothing.
 */
export class ChildManifestGate {
  private readonly applied = new Map<string, AppliedChildManifest>()
  private skipped = 0
  private sinceSample = 0

  /** True when this registration carries something the registry does not have. */
  shouldApply(childId: string, incarnation: number, params: RegisterNodeParams): boolean {
    const fingerprint = childManifestFingerprint(params)
    const previous = this.applied.get(childId)
    if (previous !== undefined && previous.incarnation === incarnation) {
      if (previous.fingerprint === fingerprint) {
        this.skipped += 1
        this.sinceSample += 1
        return false
      }
    }
    this.applied.set(childId, { incarnation, fingerprint })
    return true
  }

  /** Drop a child's record — its next register is a first register again. */
  forget(childId: string): void {
    this.applied.delete(childId)
  }

  /** How many have been skipped since the last call. Reading RESETS it. */
  skippedSince(): number {
    const n = this.skipped
    this.skipped = 0
    return n
  }

  /** True once every {@link CHILD_MANIFEST_SKIP_SAMPLE} skips. */
  sampleDue(): boolean {
    if (this.sinceSample < CHILD_MANIFEST_SKIP_SAMPLE) return false
    this.sinceSample = 0
    return true
  }
}

/**
 * E1: Adapt a child's UDS `ChildCapDescriptor[]` into a `RegisterNodeParams`
 * that `onRegisterNode` / `applyNodeManifest` can consume.
 *
 * Multi-addon manifest support (co-location): descriptors are grouped by the
 * `addonId` each one carries, producing ONE `RegisteredAddonManifest` entry
 * per hosted addon. A GROUPED runner (`execution.group`, e.g. `net-access`
 * hosting cloudflare-tunnel + cloudflare-turn + tailscale-*) therefore
 * registers each addon's caps under its REAL addon id — real provider
 * registryKeys, per-addon settings/logs/restart, correct admin-UI display
 * names. Before this, all of a group's caps collapsed under one synthetic
 * `addonId = childId` (the group name) — the "@camstack/addon-net-access"
 * admin-UI bug. A legacy child that omits `addonId` falls back to `childId`,
 * which is identical to the historical single-addon behaviour
 * (childId = runnerId = addonId when no group is declared).
 *
 * Singleton vs. device-scoped caps: `ChildCapDescriptor.deviceId` is present only
 * for device-scoped native caps. The `addons` array carries system (singleton/collection)
 * cap names; device-scoped native caps are handled separately via `nativeCaps` in the
 * full `RegisterNodeParams`.
 */
export function buildChildUdsManifest(
  nodeId: string,
  childId: string,
  caps: readonly ChildCapDescriptor[],
): RegisterNodeParams {
  // Group unique system (non-device-scoped) cap names per hosted addon.
  // Insertion order preserves the child's registration order.
  const capsByAddon = new Map<string, Set<string>>()
  for (const cap of caps) {
    if (cap.deviceId !== undefined) continue
    const addonId = cap.addonId ?? childId
    const set = capsByAddon.get(addonId) ?? new Set<string>()
    set.add(cap.capName)
    capsByAddon.set(addonId, set)
  }
  // A child with no system caps still registers an (empty) entry under its
  // childId so node bookkeeping (previous-manifest diffing, disconnect
  // cleanup) keeps a record for the node.
  if (capsByAddon.size === 0) {
    capsByAddon.set(childId, new Set<string>())
  }
  const addons: readonly RegisteredAddonManifest[] = [...capsByAddon.entries()].map(
    ([addonId, capNames]) => ({ addonId, capabilities: [...capNames] }),
  )
  return { nodeId, addons }
}
