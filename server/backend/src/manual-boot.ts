/**
 * Boot — constructs every service by hand in dependency order, runs
 * `onModuleInit` hooks in sequence, and exposes a `BootedApp` facade
 * around the Fastify instance. This is the only boot path; NestJS was
 * removed to drop the accidental DI layer on top of an already-explicit
 * dependency graph.
 */

import { randomUUID } from 'node:crypto'
import * as path from 'node:path'
import {
  AddonDepsManager,
  ConsoleDestination,
  setHuggingFaceReachabilityObserver,
} from '@camstack/system'
import type { ILocalNetworkProvider } from '@camstack/types'
import { EventCategory, memoizePinnedFfmpeg, ServerPackageStatusSchema } from '@camstack/types'
import type { FastifyInstance } from 'fastify'
import Fastify from 'fastify'
import { buildHubHttpSource } from './api/addon-upload'
import { createNodeRootPackageLookup } from './api/core/cap-providers'
import { clusterBaseUrlResolver } from './api/hub-cluster-url'
import type { InfraContext } from './boot/boot-config'
import { type InitStep, runBootInitSequence } from './boot/init-sequence'
import { PostBootService } from './boot/post-boot.service'
import { AddonPackageService } from './core/addon/addon-package.service'
import { AddonRegistryService } from './core/addon/addon-registry.service'
import { AddonSearchService } from './core/addon/addon-search.service'
import { AddonBridgeService } from './core/addon-bridge/addon-bridge.service'
import { AddonPagesService } from './core/addon-pages/addon-pages.service'
import { AddonWidgetsService } from './core/addon-widgets/addon-widgets.service'
import {
  AGENT_BACKFILL_RPC_TIMEOUT_MS,
  AgentRegistryService,
} from './core/agent/agent-registry.service'
import { ClusterNodeHistoryStore } from './core/agent/cluster-node-history-store'
import { AuthService } from './core/auth/auth.service'
import { CapabilityService } from './core/capability/capability.service'
import { ConfigService } from './core/config/config.service'
import { EventBusService } from './core/events/event-bus.service'
import { FeatureService } from './core/feature/feature.service'
import { initLifecycleRunner } from './core/lifecycle/lifecycle-runner.singleton'
import { LoggingService } from './core/logging/logging.service'
import { MoleculerService } from './core/moleculer/moleculer.service'
import { NetworkQualityService } from './core/network/network-quality.service'
import { NotificationServiceWrapper } from './core/notification/notification-wrapper.service'
import { ToastServiceWrapper } from './core/notification/toast-wrapper.service'
import { ReplEngineService } from './core/repl/repl-engine.service'
import { ServerUpdateService } from './core/server-update/server-update.service'
import {
  describeRunnerBootCheck,
  isRunnerBootCheckDegraded,
  RunnerBootCheckService,
} from './core/runner-health/runner-boot-check'
import { StorageService } from './core/storage/storage.service'
import { StreamProbeService } from './core/streaming/stream-probe.service'
import { TopologyEmitterService } from './core/topology/topology-emitter.service'
import { UpdateAvailabilityEmitter } from './core/update-availability-emitter.js'
import { FileUpdateAvailabilityStore } from './core/update-availability-store.js'
import {
  type AgentStatusBroker,
  fetchAgentInstalledPackages,
} from './core/updates/agent-installed-packages.js'
import { RegistryReachabilityTracker } from './core/updates/registry-reachability.js'
import { UpdateCheckScheduler } from './core/updates/update-check-scheduler.js'
import { WrapperUpdateChecker } from './core/updates/wrapper-update-checker.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type AnyCtor<T> = abstract new (...args: never[]) => T

/** Optional work injected into the boot init sequence — see {@link BootedApp.init}. */
export interface BootInitHooks {
  readonly beforeAddonBoot?: InitStep
}

export interface BootedApp {
  /** Resolve a service by its constructor. Throws if unregistered. */
  get<T>(ctor: AnyCtor<T>): T
  /** Returns the Fastify instance for plugin registration. */
  getHttpAdapter(): { getInstance(): FastifyInstance }
  /** Register SIGTERM/SIGINT → close() for graceful shutdown. */
  enableShutdownHooks(): void
  /**
   * Run every `onModuleInit` in dependency order.
   *
   * `hooks.beforeAddonBoot` runs with the broker live and before a single
   * addon has booted — the only place from which a service can be published on
   * the mesh in time for addon boot to CALL it. See `boot/init-sequence.ts`.
   */
  init(hooks?: BootInitHooks): Promise<void>
  /** Start the Fastify HTTP server. */
  listen(port: number, host: string): Promise<void>
  /** Run OnModuleDestroy hooks in reverse init order, then close Fastify. */
  close(): Promise<void>
}

interface BootOptions {
  infra: InfraContext
  fastifyOpts: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Service container — narrowing via `instanceof`, no casts.
// ---------------------------------------------------------------------------

class ServiceContainer {
  private readonly services = new Map<unknown, unknown>()

  register<T extends object>(ctor: AnyCtor<T>, instance: T): void {
    this.services.set(ctor, instance)
  }

  get<T>(ctor: AnyCtor<T>): T {
    const inst = this.services.get(ctor)
    if (inst === undefined) {
      throw new Error(`ServiceContainer: ${ctor.name} is not registered`)
    }
    if (!(inst instanceof ctor)) {
      throw new Error(`ServiceContainer: ${ctor.name} instance type mismatch at resolve time`)
    }
    return inst
  }
}

// ---------------------------------------------------------------------------
// Manual boot
// ---------------------------------------------------------------------------

export async function bootManual(opts: BootOptions): Promise<BootedApp> {
  const { infra, fastifyOpts } = opts
  void infra // infraContext is consumed by main.ts directly (locationManager, etc.)

  const configPath = process.env.CONFIG_PATH ?? 'camstack-data/config.yaml'

  // ---- Layer 0: services with no service deps -----------------------------
  const configService = new ConfigService(configPath)
  const storageService = new StorageService()
  const capabilityService = new CapabilityService()
  const networkQualityService = new NetworkQualityService()
  const toastWrapper = new ToastServiceWrapper()

  // ---- Layer 1: need ConfigService / LoggingService -----------------------
  const loggingService = new LoggingService(configService)
  // Bootstrap stdout, attached at the FIRST moment a LogManager exists.
  //
  // The real console destination is a core builtin that boots in pass 3, after
  // the entire runner plan: a measured boot produced no stdout at all for ~40 s
  // and then flushed the whole backlog newest-first, so every boot
  // investigation needed a parser (docs/design/boot-to-usable-camera.md, F).
  // This sink carries the window and is detached — without a second flush —
  // the moment `console-logging` registers.
  const bootstrapConsole = new ConsoleDestination()
  void bootstrapConsole.initialize()
  loggingService.attachBootstrapConsole(bootstrapConsole)
  const eventBusService = new EventBusService(configService)
  // Wire device-name cache for log formatter — subscribes here so the
  // very first DeviceRegistered event populates the cache before any
  // log line needing `deviceName` is emitted.
  loggingService.attachDeviceNameStream(eventBusService)
  // The orchestrator's per-destination Enable/Disable toggle becomes the ONE
  // truth for every log destination — it used to be write-only (nothing read
  // the disabled set), so console/winston could not be turned off at all while
  // Loki appeared to work only through a second, private `enabled` setting.
  loggingService.setDestinationEnabledCheck(
    (addonId) =>
      capabilityService.getRegistry()?.isProviderDisabled('log-destination', addonId) !== true,
  )
  const featureService = new FeatureService(configService)
  const authService = new AuthService(configService)
  // The probe runs the node's PINNED ffmpeg (D540) — resolved through the same
  // deps manager every addon is given, once, and never looked up on PATH.
  // (The manager roots binaries at the NODE's data dir whatever it is given.)
  const probeDeps = new AddonDepsManager(
    path.resolve(process.env['CAMSTACK_DATA'] ?? 'camstack-data'),
    loggingService.createLogger('StreamProbeDeps'),
  )
  const streamProbeService = new StreamProbeService(
    loggingService,
    memoizePinnedFfmpeg(() => probeDeps.ensureFfmpeg()),
  )
  const addonBridgeService = new AddonBridgeService(loggingService)
  const addonSearchService = new AddonSearchService(loggingService)

  // ---- Layer 2: need Layer 0/1 -------------------------------------------
  const notificationWrapper = new NotificationServiceWrapper(capabilityService, loggingService)
  const addonPagesService = new AddonPagesService(loggingService, configService, capabilityService)
  const moleculerService = new MoleculerService(
    eventBusService,
    configService,
    loggingService,
    capabilityService,
    streamProbeService,
  )

  // ---- Layer 3: need Moleculer / AddonRegistry ---------------------------
  const agentRegistryService = new AgentRegistryService(
    eventBusService,
    moleculerService,
    capabilityService,
  )
  const addonRegistryService = new AddonRegistryService(
    loggingService,
    eventBusService,
    configService,
    storageService,
    capabilityService,
    moleculerService,
    streamProbeService,
  )
  // AgentRegistryService needs the hub addon registry for placement-based
  // reconciliation, but is constructed first (it has no other dependency
  // on AddonRegistryService) — wire it post-construction.
  agentRegistryService.setAddonRegistry(addonRegistryService)
  // Same post-construction reason: the cluster-node lifecycle (forget, catalog
  // removal) must leave a per-node line, and `console.log` is not a log store.
  agentRegistryService.setLogger(loggingService.createLogger('ClusterNodes'))
  // A1: durable, routing-blind offline-node history — the `cluster-agent`
  // records kind, bound by the addon registry once the records provider is up
  // (unavailable until then, D902). Wired post-construction so the service's
  // 3-arg constructor stays intact.
  const clusterNodeHistoryStore = new ClusterNodeHistoryStore(
    loggingService.createLogger('cluster-node-history'),
  )
  agentRegistryService.setClusterNodeHistoryStore(clusterNodeHistoryStore)
  addonRegistryService.setClusterNodeHistoryStore(clusterNodeHistoryStore)

  // ---- Layer 4: need AddonRegistry ---------------------------------------
  // AddonWidgetsService — needs AddonRegistryService for the bundled-addon
  // dist sub-folder lookup (see service docstring).
  const addonWidgetsService = new AddonWidgetsService(
    loggingService,
    capabilityService,
    addonRegistryService,
  )
  // Durable `update.available` dedup lives next to `auto-update.json`, so a
  // hub restart never re-announces what the operator already saw.
  const availabilityDataDir = path.resolve(process.env['CAMSTACK_DATA'] ?? 'camstack-data')
  const addonPackageService = new AddonPackageService(
    loggingService,
    eventBusService,
    configService,
    addonRegistryService,
    notificationWrapper,
    toastWrapper,
    new FileUpdateAvailabilityStore(
      availabilityDataDir,
      'addon-packages',
      loggingService.createLogger('UpdateAvailability'),
    ),
  )
  // Addon back-fill delivery seam. Wired here (not in the AgentRegistryService
  // constructor) because it needs AddonPackageService, which is a later layer.
  // Bytes come from THE HUB'S OWN INSTALLED COPY whenever it has one, and only
  // from the registry when it does not. This line used to claim that while
  // calling `packPackage` — `npm pack <name>@<version>` — so the back-fill
  // repaired a node by installing the REGISTRY's build of a version over the
  // one an operator had just deployed. Same name, same version, different
  // bundle: every `camstack deploy … -n agent-a` on 2026-08-07 was
  // reverted ~1.5s later and read as a stale dist. See `packInstalledPackage`.
  // Delivery is an RPC pair, never an event (D8/D11).
  const backfillLogger = loggingService.createLogger('agent-backfill')
  // Where the agent pulls the bundle from: the hub's own cluster address, from
  // the `local-network` cap — never an env var, never loopback.
  const resolveClusterBaseUrl = clusterBaseUrlResolver(() =>
    addonRegistryService
      .getCapabilityRegistry()
      .getSingleton<ILocalNetworkProvider>('local-network'),
  )
  agentRegistryService.setAddonBackfill({
    pack: async (name, version) => {
      const installed = await addonPackageService.packInstalledPackage(name)
      // Name the SOURCE. This delivery overwrites whatever the node has, so
      // "which build did we just push" is the first question every time it goes
      // wrong — and for a whole day it was answered nowhere at all.
      backfillLogger.info('back-fill packing', {
        meta: {
          packageName: name,
          source: installed ? 'hub-installed' : 'npm-registry',
          version: installed?.version ?? version,
        },
      })
      return (installed ?? (await addonPackageService.packPackage(name, version))).buffer
    },
    deploy: async (nodeId, packageName, bundle) => {
      await moleculerService.broker.call(
        '$agent.deploy',
        { addonId: packageName, source: buildHubHttpSource(bundle, await resolveClusterBaseUrl()) },
        { nodeID: nodeId, timeout: AGENT_BACKFILL_RPC_TIMEOUT_MS },
      )
    },
    reload: async (nodeId) => {
      await moleculerService.broker.call(
        '$agent.reload',
        {},
        { nodeID: nodeId, timeout: AGENT_BACKFILL_RPC_TIMEOUT_MS },
      )
    },
  })

  // ---- Lifecycle job runner (boot singleton) -----------------------------
  // The runner used to be built per-tRPC-request inside the `addons` cap
  // factory. Boot-reconcile (F3 Task 4) and the auto-update scheduler (F3
  // Task 5) need a stable instance that exists before any request, so we build
  // it ONCE here from the addon-package service + event bus. `createdBy` is no
  // longer a construction dep — it travels on each `startJob` call.
  const lifecycleDataDir = path.resolve(process.env['CAMSTACK_DATA'] ?? 'camstack-data')
  initLifecycleRunner({
    dataDir: lifecycleDataDir,
    fetchTarball: (name, version, signal) =>
      addonPackageService.fetchAddonTarball(name, version, signal),
    extract: (tgz, destDir) => addonPackageService.extractTarball(tgz, destDir),
    applyAddonUpdate: async ({ name, version, stagedPath }) => {
      await addonPackageService.applyStagedAddonUpdate(name, version, stagedPath)
    },
    emit: (kind, job, entry) => {
      if (kind === 'progress') {
        eventBusService.emit({
          id: randomUUID(),
          timestamp: new Date(),
          source: { type: 'core', id: 'lifecycle-job-engine' },
          category: EventCategory.AddonsJobProgress,
          data: { job },
        })
      } else {
        eventBusService.emit({
          id: randomUUID(),
          timestamp: new Date(),
          source: { type: 'core', id: 'lifecycle-job-engine' },
          category: EventCategory.AddonsJobLog,
          data: { jobId: job.jobId, entry },
        })
      }
    },
  })

  const replEngineService = new ReplEngineService(
    addonRegistryService,
    eventBusService,
    loggingService,
  )
  // Runtime-updatable root package (phase 1: hub only). The service owns the
  // data-dir server-root staging/rollback lifecycle; restarts route through
  // AddonPackageService.restartServer for the marker + reconnect toast.
  // D877: the runner boot check (one-shot after boot, scheduled by main.ts) and
  // the update pre-flight (would the target refuse addons on the live store?).
  const hubRunnerBootCheck = new RunnerBootCheckService({
    logger: loggingService.createLogger('RunnerBootCheck'),
    nodeId: 'hub',
    planned: () => addonRegistryService.plannedRunnerIds(),
    listProcesses: async () => {
      const rows = await addonRegistryService.listRunnerRows()
      if (rows === null) throw new Error('the process service did not answer')
      return rows
    },
    // The verdict reaches the alert centre (one critical alert).
    onResult: (check) => {
      eventBusService.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'core', id: 'runner-boot-check' },
        category: EventCategory.SystemRunnerCheck,
        data: {
          nodeId: 'hub',
          degraded: isRunnerBootCheckDegraded(check),
          summary: describeRunnerBootCheck(check),
          expected: check.expected,
          running: check.running,
          failed: [...check.failed],
          refused: check.refused.map((r) => ({ runnerId: r.runnerId, reason: r.reason })),
          missing: [...check.missing],
        },
      })
    },
  })
  const serverUpdateService = new ServerUpdateService({
    runnerBootCheck: () => hubRunnerBootCheck.current(),
    logger: loggingService.createLogger('ServerUpdate'),
    restartServer: (requestedBy, update) => addonPackageService.restartServer(requestedBy, update),
    eventBus: eventBusService,
    updateAvailabilityStore: new FileUpdateAvailabilityStore(
      availabilityDataDir,
      'server-update',
      loggingService.createLogger('UpdateAvailability'),
    ),
  })
  const topologyEmitterService = new TopologyEmitterService(
    eventBusService,
    agentRegistryService,
    addonRegistryService,
    createNodeRootPackageLookup(moleculerService, serverUpdateService),
    (nodeId) => moleculerService.isNodeRegistered(nodeId),
  )
  const postBootService = new PostBootService(addonRegistryService, eventBusService, loggingService)

  // ---- Update availability poller ---------------------------------------
  // "Tell me, don't install." Deliberately NOT gated on the auto-update
  // channel — that gate is why the only periodic publisher was dead on every
  // live hub (`{"channel":"off"}`). See UpdateCheckScheduler.
  const updateCheckLogger = loggingService.createLogger('UpdateCheck')
  // The fifth target: the SHELL each node runs inside. Its own emitter scope,
  // so a shell announcement and a code announcement never overwrite each
  // other's dedup state — they are different facts about the same node (D437).
  const wrapperUpdateChecker = new WrapperUpdateChecker({
    logger: updateCheckLogger,
    emitter: new UpdateAvailabilityEmitter(
      eventBusService,
      { type: 'core', id: 'wrapper-update-check' },
      new FileUpdateAvailabilityStore(
        availabilityDataDir,
        'wrapper-update',
        loggingService.createLogger('UpdateAvailability'),
      ),
    ),
    readStatus: async (nodeId, isHub) => {
      if (isHub) return serverUpdateService.getServerPackageStatus()
      const proxy = moleculerService.createCapabilityProxy('server-management', nodeId)
      if (proxy === null) {
        // Unreachable is not "the image is fine". Reject so the scheduler
        // records a failed check instead of a clean bill.
        throw new Error(`server-management unreachable on ${nodeId}`)
      }
      const status: unknown = await proxy['getServerPackageStatus']?.({})
      return ServerPackageStatusSchema.parse(status)
    },
  })
  // npm / Hugging Face unreachable → one critical alert episode. No clock of
  // its own: npm is heard from the sweep below, Hugging Face from the model
  // downloads this process makes anyway.
  const registryReachability = new RegistryReachabilityTracker({
    logger: updateCheckLogger,
    getAlerts: () =>
      addonRegistryService.getCapabilityRegistry().getSingleton('alerts') ??
      undefined,
  })
  addonPackageService.setNpmReachabilityObserver({
    reached: () => registryReachability.reached('npm'),
    failed: (reason) => registryReachability.failed('npm', reason),
  })
  setHuggingFaceReachabilityObserver((outcome) => {
    void (outcome.reached
      ? registryReachability.reached('huggingface')
      : registryReachability.failed('huggingface', outcome.detail))
  })
  const updateCheckScheduler = new UpdateCheckScheduler({
    logger: updateCheckLogger,
    getIntervalSeconds: () =>
      addonPackageService.getAutoUpdateSettings().updateCheckIntervalSeconds,
    targets: {
      listNodes: () => agentRegistryService.listNodeLiveness(),
      checkHubAddons: () => addonPackageService.checkUpdates(true),
      checkFrameworkPackages: () => addonPackageService.listFrameworkPackages(),
      checkAgentAddons: async (nodeId) => {
        const broker: AgentStatusBroker = moleculerService.broker
        const installed = await fetchAgentInstalledPackages(broker, nodeId)
        return addonPackageService.checkUpdatesForInstalled(installed, nodeId)
      },
      checkNodeServerUpdate: async (nodeId, isHub) => {
        if (isHub) return serverUpdateService.checkServerUpdate()
        const proxy = moleculerService.createCapabilityProxy('server-management', nodeId)
        if (proxy === null) {
          // A node with no reachable `server-management` cannot be checked —
          // say so rather than counting it as up to date.
          updateCheckLogger.warn('Update check skipped — server-management unreachable', {
            tags: { nodeId },
          })
          return undefined
        }
        return proxy['checkServerUpdate']?.({})
      },
      checkWrapperUpdate: (nodeId, isHub) => wrapperUpdateChecker.check(nodeId, isHub),
    },
  })
  addonPackageService.setUpdateCheckRescheduler(() => updateCheckScheduler.reschedule())
  updateCheckScheduler.start()

  // ---- Container ---------------------------------------------------------
  const container = new ServiceContainer()
  container.register(ConfigService, configService)
  container.register(LoggingService, loggingService)
  container.register(EventBusService, eventBusService)
  container.register(StorageService, storageService)
  container.register(CapabilityService, capabilityService)
  container.register(FeatureService, featureService)
  container.register(AuthService, authService)
  container.register(StreamProbeService, streamProbeService)
  container.register(NetworkQualityService, networkQualityService)
  container.register(ToastServiceWrapper, toastWrapper)
  container.register(NotificationServiceWrapper, notificationWrapper)
  container.register(AddonPagesService, addonPagesService)
  container.register(AddonWidgetsService, addonWidgetsService)
  container.register(AddonBridgeService, addonBridgeService)
  container.register(MoleculerService, moleculerService)
  container.register(AgentRegistryService, agentRegistryService)
  container.register(AddonRegistryService, addonRegistryService)
  container.register(AddonSearchService, addonSearchService)
  container.register(AddonPackageService, addonPackageService)
  container.register(ReplEngineService, replEngineService)
  container.register(ServerUpdateService, serverUpdateService)
  container.register(RunnerBootCheckService, hubRunnerBootCheck)
  // A runner settling (READY / crashed / failed / refused) re-evaluates a verdict
  // that still had runners on their way (D877).
  eventBusService.subscribe({ category: EventCategory.ProcessStateChanged }, () =>
    hubRunnerBootCheck.noteRunnerChange(),
  )
  container.register(TopologyEmitterService, topologyEmitterService)
  container.register(PostBootService, postBootService)
  container.register(UpdateCheckScheduler, updateCheckScheduler)

  // ---- Fastify instance --------------------------------------------------
  const fastify = Fastify(fastifyOpts)

  // /health and /health/* — registered in `main.ts` via
  // `registerHealthRoutes` once MoleculerService + AgentRegistryService are
  // available. The detailed shape is shared with each agent's `/health`
  // (see `packages/agent/src/agent-http.ts`).

  // ---- Shutdown coordination --------------------------------------------
  let closed = false
  let shutdownHooksRegistered = false

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    const logErr = (label: string, err: unknown): void => {
      console.error(`[manual-boot] ${label} destroy failed:`, err)
    }
    try {
      updateCheckScheduler.stop()
    } catch (err) {
      logErr('UpdateCheckScheduler', err)
    }
    try {
      topologyEmitterService.onModuleDestroy()
    } catch (err) {
      logErr('TopologyEmitter', err)
    }
    try {
      await addonRegistryService.onModuleDestroy()
    } catch (err) {
      logErr('AddonRegistry', err)
    }
    try {
      await addonBridgeService.onModuleDestroy()
    } catch (err) {
      logErr('AddonBridge', err)
    }
    try {
      await moleculerService.onModuleDestroy()
    } catch (err) {
      logErr('Moleculer', err)
    }
    try {
      await fastify.close()
    } catch (err) {
      logErr('Fastify', err)
    }
  }

  return {
    get<T>(ctor: AnyCtor<T>): T {
      return container.get(ctor)
    },
    getHttpAdapter() {
      return { getInstance: () => fastify }
    },
    enableShutdownHooks() {
      if (shutdownHooksRegistered) return
      shutdownHooksRegistered = true
      const handler = (): void => {
        close().catch((err) => {
          console.error('[manual-boot] shutdown close failed:', err)
        })
      }
      process.once('SIGTERM', handler)
      process.once('SIGINT', handler)
    },
    async init(hooks = {}) {
      // The order and the `beforeAddonBoot` seam live in `runBootInitSequence`
      // — see `boot/init-sequence.ts` for why that seam is load-bearing.
      await runBootInitSequence({
        moleculer: () => moleculerService.onModuleInit(),
        addonBridge: () => addonBridgeService.onModuleInit(),
        agentRegistry: () => {
          agentRegistryService.onModuleInit()
        },
        ...(hooks.beforeAddonBoot !== undefined ? { beforeAddonBoot: hooks.beforeAddonBoot } : {}),
        addonBoot: () => addonRegistryService.onModuleInit(),
        afterAddonBoot: () => {
          // Reconcile already-connected agents now that the hub's installed
          // addon set is populated. Agents online before the hub started never
          // fire a fresh `$node.connected` event, so the per-connect trigger
          // alone would miss them — this catches the boot-time case (e.g. a
          // long-running dev-agent with a now-stale addon). Fire-and-forget so
          // an unreachable agent never delays boot.
          void agentRegistryService.reconcileConnectedAgents()
          // Topology emitter must boot AFTER AgentRegistry + AddonRegistry —
          // its initial snapshot reads both. Subscribes to lifecycle events
          // for incremental snapshots and emits a periodic safety net.
          topologyEmitterService.onModuleInit()
        },
      })
    },
    async listen(port, host) {
      await fastify.listen({
        port,
        host,
        // Dual-stack when binding `::`. Positional listen() drops this and
        // on macOS/BSD `IPV6_V6ONLY` defaults to 1 — IPv4 clients die.
        ipv6Only: host === '::' ? false : undefined,
      })
    },
    close,
  }
}
