import * as fs from 'node:fs'
import {
  RunnerBootCheckService,
  type RunnerStateRow,
} from '../core/runner-health/runner-boot-check.js'
import * as path from 'node:path'
import type {
  AddonContextOptions,
  ChildCapDescriptor,
  InProcessProviderLookup,
  InProcessProviderRef,
  PendingTransporter,
  RegisteredAddonManifest,
  RegisterNodeParams,
} from '@camstack/system'
import {
  AddonInstaller,
  AddonLoader,
  AGENT_READINESS_SERVICE_NAME,
  buildNodeManifest,
  CapabilityRegistry,
  createAddonContext,
  createAddonService,
  buildTransporter,
  connectBrokerTransport,
  createAgentTransport,
  createBroker,
  currentBrokerTransporter,
  disconnectBrokerTransport,
  installBrokerTransporter,
  isInstalledTransporter,
  createLocalTransport,
  createParentUnownedCallHandler,
  createProcessService,
  createReadinessServiceForRegistry,
  createUdsEventBridge,
  deriveAgentListenPort,
  detectWorkspacePackagesDir,
  getBrokerEventBus,
  getOrInitReadinessRegistry,
  HUB_CAP_FWD_ACTION,
  HubNodeRegistry,
  LocalChildRegistry,
  localEndpointPath,
  registerEventBusService,
  setNodeEventInterest,
  subscribePassthrough,
  udsChildLogToWorkerEntry,
  redactLogMeta,
  redactLogText,
  AgentMdnsAdvertiser,
  AgentPairing,
  createCiaoPublisher,
  TlsTcpTransporter,
  NativeMetricsProvider,
} from '@camstack/system'
import { EventCategory } from '@camstack/types'
import type {
  IEventBus,
  ILogDestination,
  IMetricsProvider,
  IScopedLogger,
  IStorageProvider,
} from '@camstack/types'
// Capability definitions — must be declared before addon registerProvider() calls
import {
  ALL_CAPABILITY_DEFINITIONS,
  audioAnalyzerCapability,
  dataStoreProviderCapability,
  decoderCapability,
  errMsg,
  filesystemBrowseCapability,
  isDeployableToAgent,
  logDestinationCapability,
  metricsProviderCapability,
  motionDetectionCapability,
  nodeCertificatesCapability,
  normalizeAddonInitResult,
  pipelineExecutorCapability,
  pipelineRunnerCapability,
  platformProbeCapability,
  resolveAddonPlacement,
  resolveRunnerId,
  serverManagementCapability,
  settingsStoreCapability,
  storageCapability,
  storageProviderCapability,
} from '@camstack/types'
import type { ServiceBroker } from 'moleculer'
import { buildServerManagementProvider } from '../api/core/server-management.provider.js'
import { resolveHubClosurePackageDir } from '../core/addon/package-dir-utils.js'
import { runSingleCopyCleanup } from '../single-copy-cleanup-runner.js'
import { BUILTINS_PACKAGE, planAgentAddonScan, resolveAddonPackageDirs } from './addon-scan.js'
import { buildAgentAddonUpdateReport } from './agent-addon-updates.js'
import { createAgentHubRegistration } from './agent-hub-registration.js'
import { createAgentMeshGate } from './agent-mesh-gate.js'
import { createLocalPairingAnnouncer } from './agent-pairing-local.js'
import { AgentMembershipWatch } from './agent-membership-watch.js'
import {
  forgetPairing,
  isAgentPaired,
  pairedLeafFingerprint,
  persistPairing,
  readPairedHubIdentity,
} from './agent-pairing-store.js'
import { askHubMembership } from './hub-membership-client.js'
import type { AgentMeshTls } from './agent-config.js'
import { loadAgentConfig } from './agent-config.js'
import {
  ensureGroupRunner,
  type GroupCandidate,
  isGroupRunnerAddon,
  readPackageManifestAddons,
  registerGroupRunnerProviders,
} from './agent-group-runner.js'
import type { HubConnectionState } from './agent-http.js'
import { startAgentHttpServer } from './agent-http.js'
import { createAgentNodeCertificates } from './agent-node-certificates.js'
import { createReconnectRunner } from './agent-reconnect.js'
import { createSerialQueue } from './serial-queue.js'
import type { SniffingListener } from './agent-sniffing-listener.js'
import { decideAgentBootMode } from './agent-boot-mode.js'
import { resolveStatusMetrics } from './agent-status-metrics.js'
import {
  agentSelfUpdateEnabled,
  runAgentSelfUpdate,
  type AgentSelfUpdatePorts,
} from './agent-self-update.js'
import { DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS } from '../core/updates/update-check-scheduler.js'
import { resolveAgentInfraCapabilities } from './agent-infra-capabilities.js'
import type { LoadedAddonEntry } from './agent-service.js'
import { createAgentService } from './agent-service.js'
import type { AgentUpdateControls } from './agent-update-routes.js'
import { createAgentHubAddonControls } from './agent-hub-addon-update.js'
import { createAgentServerUpdateControls } from './agent-update-routes.js'
import {
  AGENT_RUNTIME_ADDON_ID,
  AgentUpdateService,
  agentRuntimeManifestEntry,
  scheduleAgentRestart,
} from './agent-update-service.js'
import { deriveHubUrlForExport, deriveHubUrlFromHubAddress } from './derive-hub-url.js'
import type { InfraResolution } from './infra-boot-guard.js'
import { assertRequiredInfraResolved } from './infra-boot-guard.js'
import { planInfraBoot, planToResolutions } from './infra-boot-plan.js'
import { registerAgentCapDispatch } from './register-agent-cap-dispatch.js'

// ---------------------------------------------------------------------------
// Agent LogManager — shared log pipeline for all addon loggers.
// The hub-forwarder addon registers as a destination, so all log
// entries flow through it (console output + hub forwarding).
// ---------------------------------------------------------------------------
import { LogManager, systemHostFacts } from '@camstack/system'
import { startAgentHeapWatch } from './agent-heap-watch.js'

/** A reconnect (stop + rebuild + start) that takes longer than this is abandoned. */
const RECONNECT_DEADLINE_MS = 90_000
/** How often the agent re-evaluates whether to ask its hub "am I still a member?" (D857). */
const MEMBERSHIP_TICK_MS = 15_000

const agentLogManager = new LogManager(5000)

/**
 * Caps whose `nodeId` arg is provider DATA (`nodeIdMode: 'data'` —
 * `addon-settings`, `addons`, `nodes`, `pipeline-orchestrator`), never a
 * routing pin. The agent's own capabilityRegistry only declares the agent
 * caps, so derive the set from the static cap definitions shipped in
 * `@camstack/types`. Fed to `createParentUnownedCallHandler` so a forked
 * addon on this agent calling e.g.
 * `addon-settings.getGlobalSettings({addonId, nodeId})` forwards UNPINNED to
 * the hub singleton (which reads `nodeId` as data) instead of being pinned to
 * a node with no provider (dead broker fallback → ServiceNotFoundError).
 */
const DATA_NODEID_CAPS: ReadonlySet<string> = new Set(
  ALL_CAPABILITY_DEFINITIONS.filter((c) => c.nodeIdMode === 'data').map((c) => c.name),
)

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function startAgent(configPath?: string): Promise<void> {
  // The agent root's own memory: `[mem] agent-main` heartbeat + the stranded-page
  // reclaim hub-main has had since 2026-08. Started first so a slow boot is on the
  // record; lines reach the hub through the same LogManager the addons use.
  const heapWatchLogger = agentLogManager.createLogger().withTags({ addonId: 'heap-watch' })
  startAgentHeapWatch(heapWatchLogger)
  const config = loadAgentConfig(configPath)

  // Derive CAMSTACK_HUB_URL from the configured hub address so remote agents
  // no longer need a second, redundant env var set by hand (the cross-node
  // source trap). An explicit operator value ALWAYS wins — capture whether it
  // was set BEFORE deriving so reconnect() can still update a derived value.
  // This runs before every runner spawn (loadClusterCapableAddons /
  // loadDeployedAddons below), and process-service spreads `process.env` into
  // child env, so pipeline-runner + recorder children inherit it for free.
  const hubUrlWasExplicit = process.env['CAMSTACK_HUB_URL'] !== undefined
  const derivedHubUrl = deriveHubUrlForExport(hubUrlWasExplicit, config.hubAddress)
  if (derivedHubUrl !== undefined) {
    process.env['CAMSTACK_HUB_URL'] = derivedHubUrl
    console.log(
      `[Agent] Derived CAMSTACK_HUB_URL=${derivedHubUrl} from hub address "${config.hubAddress}"`,
    )
  }

  if (config.hubAddress) {
    console.log(
      `[Agent] Starting node "${config.nodeId}" (name="${config.name}") connecting to ${config.hubAddress}`,
    )
  } else {
    console.log(
      `[Agent] Starting node "${config.nodeId}" (name="${config.name}") with no hub address — set one from the agent UI`,
    )
  }
  console.log(`[Agent] Config: ${config.configPath}`)
  console.log(`[Agent] Data dir: ${config.dataDir}`)

  // Ensure required addon packages are installed in the agent's addonsDir.
  // Resolution order:
  //   1. `CAMSTACK_BUNDLED_ADDONS_DIR` — Electron-packaged builds copy out of
  //      the closure's own scope dir, `<resourcesPath>/node_modules/@camstack`
  //      (`'local'` mode). Was a second `<resourcesPath>/addons` tree until
  //      2026-08-25 — see `packages/desktop/src/process-manager.ts`.
  //   2. Otherwise npm from registry. Local dev pushes addons via
  //      `camstack deploy` (CLI tarball upload), bypassing this path.
  const explicitSource = process.env['CAMSTACK_INSTALL_SOURCE'] as 'npm' | 'local' | undefined
  const bundledDir = process.env['CAMSTACK_BUNDLED_ADDONS_DIR']
  let workspaceDir: string | null = null
  let resolvedSource: typeof explicitSource = explicitSource
  if (bundledDir && fs.existsSync(bundledDir)) {
    workspaceDir = bundledDir
    resolvedSource = 'local'
    console.log(`[Agent] Using bundled addons from ${bundledDir}`)
  } else if (explicitSource === 'local') {
    workspaceDir = detectWorkspacePackagesDir(config.dataDir)
  }
  const installer = new AddonInstaller({
    addonsDir: config.addonsDir,
    workspacePackagesDir: workspaceDir ?? undefined,
    installSource: resolvedSource,
  })
  await installer.ensureRequiredPackages(AddonInstaller.AGENT_PACKAGES)

  // Restore repair, mirroring the hub launcher (D338): reinstall ONLY the
  // runtime deps that are neither present nor resolvable from the closure.
  if (typeof installer.ensureAddonRuntimeDeps === 'function') {
    try {
      const depsResult = await installer.ensureAddonRuntimeDeps()
      if (
        depsResult.linked.length > 0 ||
        depsResult.reinstalled.length > 0 ||
        depsResult.failed.length > 0
      ) {
        console.log(
          `[Agent] Addon runtime deps ensured — linked: [${depsResult.linked.join(', ')}], ` +
            `reinstalled: [${depsResult.reinstalled.join(', ')}], ` +
            `failed: [${depsResult.failed.join(', ')}] (${depsResult.checked} checked)`,
        )
      }
    } catch (err) {
      console.warn(
        `[Agent] ensureAddonRuntimeDeps failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  console.log(`[Agent] Addon packages ready in ${config.addonsDir}`)

  // D802, D857: the inbound mesh gate. Only the hub may call this agent, and the hub is
  // recognised by the certificate the agent's own TLS listener verified. The transport is
  // read at call time because a reconnect replaces it.
  const meshGate = createAgentMeshGate({
    nodeId: config.nodeId,
    isVerifiedPeer: (nodeId) => {
      const tx = currentBrokerTransporter(broker).tx
      return tx instanceof TlsTcpTransporter && tx.verifiedPeer(nodeId) !== undefined
    },
    log: (msg) => console.log(`[Agent] ${msg}`),
  })

  // Mesh mTLS: with a certificate (pairing, D857) the broker dials the hub's TLS
  // port; an unpaired agent has none and admits no mesh peer at all.
  let currentMeshTls: AgentMeshTls | null = config.meshTls ?? null
  // The HTTP/HTTPS listener on the agent port (D856); set once it is up.
  let agentHttpListener: SniffingListener | null = null
  console.log(
    `[Agent] Mesh transport: ${currentMeshTls !== null ? 'tls (paired)' : 'none (unpaired)'}`,
  )

  const broker = createBroker({
    nodeID: config.nodeId,
    mode: 'agent',
    hubAddress: config.hubAddress,
    logLevel: config.logLevel,
    middlewares: meshGate.middlewares,
    ...(currentMeshTls !== null ? { meshTls: currentMeshTls } : {}),
  })
  /**
   * Reconnect: reload the config from file and replace the broker's TRANSPORT (the new hub
   * address, secret or mesh leaf) IN PLACE. The broker itself is never rebuilt: its services
   * (`$agent`, `$process`, `$agent-cap-fwd`, the event bus, the addon services), its registries and
   * the forked child runners all outlive the wire. Rebuilding the broker stopped `$process`, which
   * SIGTERMed every runner, and left the node capless with no `$agent-cap-fwd` (D856 amendment,
   * 2026-10-15 incident). The HTTP server stays alive throughout.
   */
  // ONE reconnect at a time (serial-queue.ts): the UI, a mesh leaf swap and its rollback can
  // all ask for one, and two interleaved disconnect/connect cycles would leave two wires or none.
  const reconnect = createSerialQueue(() => reconnectNow(), {
    deadlineMs: RECONNECT_DEADLINE_MS,
    onTimeout: () => {
      // A transport whose connect never settles must not hold every later reconnect (including
      // the rollback of a failed leaf swap): drop the wire and move on. The broker, and the
      // runners behind it, stay.
      consoleLogger.error(
        'Reconnect did not finish in time - dropping the half-connected transport',
        {
          meta: { deadlineMs: RECONNECT_DEADLINE_MS },
        },
      )
      void disconnectBrokerTransport(broker).catch(() => undefined)
    },
  })
  // The cycle itself runs through a generation guard: a run the queue abandoned at its deadline
  // that resumes later installs nothing (agent-reconnect.ts), so two transports never share a broker.
  let pendingConfig: ReturnType<typeof loadAgentConfig> | null = null
  const reconnectNow = createReconnectRunner<PendingTransporter>({
    current: () => currentBrokerTransporter(broker),
    assign: (next) => installBrokerTransporter(broker, next),
    stop: async (target) => {
      // Only the transport installed right now: a late, abandoned run must not tear down a
      // newer run's transport.
      if (isInstalledTransporter(broker, target)) {
        await disconnectBrokerTransport(broker)
      }
    },
    prepare: () => {
      console.log('[Agent] Reconnecting with updated config...')
      // Reload config from file (pairing, the UI or a local call may have written it)
      const fresh = loadAgentConfig(undefined, config.dataDir)
      pendingConfig = fresh
      console.log(
        `[Agent] New config: hub=${fresh.hubAddress ?? 'none'}, ` +
          `mesh=${fresh.meshTls !== undefined ? 'tls (paired)' : 'none (unpaired)'}`,
      )

      // Re-derive CAMSTACK_HUB_URL when the dashboard has just written a hubAddress. Explicit operator values
      // still win via the boot-captured `hubUrlWasExplicit` flag.
      // KNOWN LIMITATION (Stage-0): runners already spawned before this reconnect
      // keep the env they inherited; picking up a changed hub address in live
      // children would need a runner respawn. Boot-time — the actual trap — is
      // fully covered.
      const freshHubUrl = deriveHubUrlForExport(hubUrlWasExplicit, fresh.hubAddress)
      if (freshHubUrl !== undefined && process.env['CAMSTACK_HUB_URL'] !== freshHubUrl) {
        process.env['CAMSTACK_HUB_URL'] = freshHubUrl
        console.log(
          `[Agent] Derived CAMSTACK_HUB_URL=${freshHubUrl} from hub address "${fresh.hubAddress}"`,
        )
      }
      currentMeshTls = fresh.meshTls ?? null
    },
    build: () => {
      const fresh = pendingConfig
      if (fresh === null) throw new Error('reconnect: no configuration was prepared')
      return buildTransporter(
        createAgentTransport({
          nodeID: config.nodeId,
          mode: 'agent',
          hubAddress: fresh.hubAddress,
          logLevel: fresh.logLevel,
          ...(currentMeshTls !== null ? { meshTls: currentMeshTls } : {}),
        }),
      )
    },
    // The new wire's hub connection re-sends the manifest (`registration.onHubConnected`):
    // the subtree union, every child included (D3).
    start: async () => {
      await connectBrokerTransport(broker)
      console.log('[Agent] Reconnected successfully')
    },
    onSuperseded: (stage) =>
      consoleLogger.warn('A superseded reconnect stopped without installing a second transport', {
        meta: { stage },
      }),
  })

  const loadedAddons = new Map<string, LoadedAddonEntry>()

  // D3 subtree registry: accumulates manifests from every group-runner child
  // that calls `$agent.registerNode`. The agent re-registers the UNION of its
  // own in-process addons + all children with the hub on every child update.
  const subtree = new HubNodeRegistry()

  // ---------------------------------------------------------------------------
  // Hub connection state tracking (for richer UI status)
  // ---------------------------------------------------------------------------
  // Tracks the last known discriminated state so the HTTP status endpoint
  // can surface `certificate-rejected` which is not observable from the broker
  // registry alone. All mutations are synchronous/single-threaded (Node.js
  // event loop) so no locking is needed.
  let hubConnectionStateOverride: HubConnectionState | null = null

  function getHubConnectionState(): HubConnectionState {
    // If a definitive override is set (e.g. certificate-rejected), return it
    // regardless of registry state.
    if (hubConnectionStateOverride !== null) return hubConnectionStateOverride
    // Fall through to live registry-derived state (connected/unconfigured/disconnected).
    // getRegistryNodes-equivalent inline: broker.registry.getNodeList
    try {
      const nodes = broker.registry.getNodeList({ onlyAvailable: true })
      if (nodes.some((n) => n.id === 'hub')) return 'connected'
    } catch {
      /* fall through */
    }
    if (!isAgentPaired(config.configPath)) return 'unpaired'
    const configNow = readConfigFile(config.configPath)
    const hubAddressConfigured =
      typeof configNow.hubAddress === 'string' && configNow.hubAddress.length > 0
    return hubAddressConfigured ? 'disconnected' : 'unconfigured'
  }

  function readConfigFile(p: string): Record<string, unknown> {
    if (!fs.existsSync(p)) return {}
    try {
      return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  // AbortController for the upward hub registration retry loop — cancelled on
  // agent shutdown so we don't leak the retry loop after stop().
  const registerAbortController = new AbortController()
  // The hub's `@camstack/server` version from the last `registerNode` ack (agent self-update).
  let hubServerVersion: string | null = null
  let selfUpdateOnFirstAck: (() => void) | null = null

  /**
   * Build the manifest for the agent's OWN in-process addons (those loaded by
   * bootCoreAddons and loadDeployedAddons that ended up in `loadedAddons` WITH
   * an `addon` instance). Group-spawned addons (loadClusterCapableAddons) have
   * no `addon` instance and register via `$agent.registerNode` from the child.
   *
   * We reconstruct per-addon capability lists by reverse-querying the
   * capabilityRegistry: for every declared capability, check which addonId
   * currently holds the provider and group the result by addonId.
   */
  function buildAgentOwnManifest(): readonly RegisteredAddonManifest[] {
    // Build addonId → capNames map from the registry.
    const addonCapMap = new Map<string, string[]>()

    for (const cap of agentCapabilities) {
      if (cap.mode === 'collection') {
        // Collection caps: multiple providers keyed by addonId.
        for (const [addonId] of capabilityRegistry.getCollectionEntries(cap.name)) {
          const list = addonCapMap.get(addonId) ?? []
          list.push(cap.name)
          addonCapMap.set(addonId, list)
        }
      } else {
        // Singleton caps: one active provider.
        const addonId = capabilityRegistry.getSingletonAddonId(cap.name)
        if (addonId) {
          const list = addonCapMap.get(addonId) ?? []
          list.push(cap.name)
          addonCapMap.set(addonId, list)
        }
      }
    }

    // Only emit in-process addons (those with an `addon` instance).
    const result: RegisteredAddonManifest[] = []
    for (const [addonId, entry] of loadedAddons) {
      if (!entry.addon) continue
      const caps = addonCapMap.get(addonId) ?? []
      result.push({ addonId, capabilities: caps })
    }
    // The agent runtime's OWN providers (server-management) are registered by
    // the bootstrap, not an addon — append their synthetic manifest entry so
    // the hub's HubNodeRegistry (and nodeId-pinned cap routing) sees them.
    result.push(agentRuntimeManifestEntry())
    return result
  }

  /**
   * Aggregate the agent's own manifest + every child's manifest into a single
   * RegisterNodeParams for the agent's nodeId. This is sent upward to the hub.
   */
  function aggregateManifest(): RegisterNodeParams {
    const ownAddons = buildAgentOwnManifest()
    const allAddons: RegisteredAddonManifest[] = [...ownAddons]
    const allNativeCaps = []

    for (const childNodeId of subtree.listNodeIds()) {
      const childAddons = subtree.getNodeManifest(childNodeId)
      if (childAddons) {
        allAddons.push(...childAddons)
      }
      const childNativeCaps = subtree.getNodeNativeCaps(childNodeId)
      if (childNativeCaps) {
        allNativeCaps.push(...childNativeCaps)
      }
    }

    // Version visibility (runtime-updatable node packages): the manifest
    // carries the agent's root-package identity so the hub's HubNodeRegistry
    // (and the Server management UI) sees every node's exact version.
    const rootPackage = agentUpdateService.getRunningRootPackage()
    return buildNodeManifest(
      config.nodeId,
      allAddons,
      allNativeCaps.length > 0 ? allNativeCaps : undefined,
      rootPackage.version === null
        ? undefined
        : { name: rootPackage.name, version: rootPackage.version },
    )
  }

  /**
   * The upward `$hub.registerNode` registration carrying the agent's complete
   * subtree union (`agent-hub-registration.ts`). Sent:
   *   - once boot has loaded every addon (`registration.ready()`);
   *   - on every `$agent.registerNode` from a child, and on `$agent.reload`;
   *   - every time the hub node connects, and when the hub asks for it
   *     (`$agent.requestRegistration`, on the hub's own `$node.connected`).
   * D857: no join to wait for and no secret in the manifest — the hub knows
   * who this agent is from its certificate.
   */
  const registration = createAgentHubRegistration({
    buildManifest: () => aggregateManifest(),
    broker: () => broker,
    signal: registerAbortController.signal,
    log: (msg) => console.log(`[Agent] ${msg}`),
    // The hub acked the manifest — the agent reached its registered state.
    // Run the single-copy GC sweep once (first ack only; no-op after).
    onAcked: (ackedHubServerVersion) => {
      if (hubConnectionStateOverride === 'certificate-rejected') hubConnectionStateOverride = null
      hubServerVersion = ackedHubServerVersion
      confirmAgentBootHealthy()
      // Paired: the first ack is the first moment the hub's version is known.
      const firstAck = selfUpdateOnFirstAck
      selfUpdateOnFirstAck = null
      firstAck?.()
    },
    onCertificateRefused: () => {
      if (hubConnectionStateOverride === 'certificate-rejected') return
      consoleLogger.error(
        "the hub does not accept this agent's certificate (revoked, or issued by another CA) — pair it again: unpair it here, then pair it from the hub (System → Cluster → Agents)",
      )
      // Surface it in the UI status.
      hubConnectionStateOverride = 'certificate-rejected'
    },
  })

  const consoleLogger: IScopedLogger = {
    info: (msg) => console.log(`[Agent] ${msg}`),
    warn: (msg) => console.warn(`[Agent] ${msg}`),
    error: (msg) => console.error(`[Agent] ${msg}`),
    debug: (msg) => console.debug(`[Agent] ${msg}`),
    child: () => consoleLogger,
    withTags: () => consoleLogger,
  }
  const capabilityRegistry = new CapabilityRegistry(consoleLogger)
  let unpairedMetrics: NativeMetricsProvider | null = null

  // Declare all capabilities the agent uses — required before registerProvider()
  const agentCapabilities = [
    storageCapability,
    storageProviderCapability,
    // The path browser for "add a storage location on this node" — the agent
    // registers the provider since day one, but without DECLARING the cap
    // here the hub's manifest never learns of it and node-routed browse
    // answers "not available on node X" (2026-07-30 fix).
    filesystemBrowseCapability,
    // The agent runs the same two-addon data topology as the hub (D44):
    // `settings-store` is the door served by storage-orchestrator,
    // `data-store-provider` is the engine sqlite-settings registers. BOTH
    // must be declared here — this array is hand-curated and nothing else
    // teaches an agent a capability, so omitting the engine leaves the
    // agent's door with nothing behind it.
    settingsStoreCapability,
    dataStoreProviderCapability,
    logDestinationCapability,
    metricsProviderCapability,
    decoderCapability,
    motionDetectionCapability,
    pipelineExecutorCapability,
    pipelineRunnerCapability,
    audioAnalyzerCapability,
    platformProbeCapability,
    serverManagementCapability,
    // Certificates of THIS node, called by the hub (D856): mesh leaf renewal and the
    // hub-issued HTTPS leaf. Provided by the runtime, like `server-management`.
    nodeCertificatesCapability,
  ]
  for (const cap of agentCapabilities) {
    capabilityRegistry.declareCapability(cap)
  }

  // ── Runtime-updatable root package ───────────────────────────────────
  // The agent hosts its own `server-management` provider, backed by the
  // update service that stages `@camstack/server` closures into
  // `<dataDir>/server-root/`. Registered under the synthetic
  // `agent-runtime` addonId (no addon owns it); `buildAgentOwnManifest`
  // appends the matching manifest entry so the hub can route
  // nodeId-pinned `server-management` calls here.
  // D877: the agent's runner boot check. Only the hub plans which addons an
  // agent runs, so the agent compares what its process service holds (a runner
  // that failed or refused is named; one that never spawned is not knowable here).
  let agentRunnerBootCheck: RunnerBootCheckService | null = null
  const agentUpdateService = new AgentUpdateService({
    logger: consoleLogger,
    dataDir: config.dataDir,
    runnerBootCheck: () => agentRunnerBootCheck?.current(),
  })
  capabilityRegistry.registerProvider(
    'server-management',
    AGENT_RUNTIME_ADDON_ID,
    buildServerManagementProvider(agentUpdateService, config.dataDir),
  )

  // The agent's certificates (D856): mesh leaf swap with automatic rollback, and the
  // hub-issued HTTPS leaf hot-swapped into the sniffing listener. The listener is
  // created later in boot, so it is read through a getter.
  capabilityRegistry.registerProvider(
    'node-certificates',
    AGENT_RUNTIME_ADDON_ID,
    createAgentNodeCertificates({
      nodeId: config.nodeId,
      dataDir: config.dataDir,
      configPath: config.configPath,
      reconnect,
      // The hub unpairs this agent (D857): answered first, then erase and reconnect unpaired.
      forgetHub: () => {
        const timer = setTimeout(() => void forgetHubNow('the hub unpaired this agent'), 300)
        timer.unref?.()
      },
      getHttpsListener: () => agentHttpListener,
      hostFacts: systemHostFacts(),
      log: {
        info: (message, extras) => consoleLogger.info(message, extras),
        warn: (message, extras) => consoleLogger.warn(message, extras),
        error: (message, extras) => consoleLogger.error(message, extras),
      },
    }),
  )

  // Boot-health confirmation: on the agent's FIRST acked `$hub.registerNode`,
  // run the single-copy GC sweep once. Under the single-copy model there is NO
  // probation boot, NO N-1 promotion, and NO auto-rollback — the starter
  // already swapped the one `current/` copy in place, so `confirmBootHealthy`
  // is a pure best-effort sweep of orphaned transient dirs. Idempotent: it
  // runs at most once per boot.
  let agentBootConfirmed = false
  const confirmAgentBootHealthy = (): void => {
    if (agentBootConfirmed) return
    agentBootConfirmed = true
    try {
      agentUpdateService.confirmBootHealthy()
      agentUpdateService.emitRestartCompletedIfPending()
    } catch (err) {
      consoleLogger.warn(
        `agent root boot confirmation failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    // ONE COPY PER NODE — the same sweep the hub runs, at this role's own
    // healthy-boot moment (D45, task 32). Operator, 2026-08-13: "l'agente deve
    // essere identico all'hub" [the agent must be identical to the hub]. An agent is where the redundant copies actually
    // are: `agent-a` still holds `<dataDir>/addons/@camstack/system@1.2.78`
    // — a copy nothing loads (both roles pass `['@camstack/system']` as the
    // loader's skip list) and that WINS over the closure for anything resolving
    // through it.
    void runSingleCopyCleanup({
      dataDir: config.dataDir,
      addonRoot: config.addonsDir,
      log: (line) => consoleLogger.info(line),
    })
  }

  // Logger factory — creates scoped loggers from the shared LogManager.
  // All entries flow through registered ILogDestination providers (hub-forwarder).
  // No scope — the brand bracket `[agent/addonId]` already identifies the addon.
  // `addonId` tag is required for the brand bracket resolver.
  const loggerFactory = (addonId: string) => agentLogManager.createLogger().withTags({ addonId })

  const agentServiceSchema = createAgentService({
    addonsDir: config.addonsDir,
    dataDir: config.dataDir,
    agentName: config.name,
    configPath: config.configPath,
    loadedAddons,
    // Resolve the current metrics-provider cap lazily from the registry.
    // The cap is registered during bootCoreAddons but may not exist in test
    // scenarios — `null` is a documented fallback for both.
    // An UNPAIRED agent boots no addon, so the registry has no provider: its own page
    // reads the same native reader the addon would register (see agent-status-metrics.ts).
    getMetricsProvider: resolveStatusMetrics(
      () => capabilityRegistry.getSingleton<IMetricsProvider>('metrics-provider'),
      () => {
        if (decideAgentBootMode({ paired: isAgentPaired(config.configPath) }) === 'full')
          return null
        if (unpairedMetrics === null) {
          unpairedMetrics = new NativeMetricsProvider()
          unpairedMetrics.startSampling(5000)
        }
        return unpairedMetrics
      },
    ),
    agentVersion: readAgentVersion(),
    // Drives `$agent.reload` — re-runs the same discovery pass the bootstrap
    // does at startup, picking up tarballs just landed via `$agent.deploy`.
    // `storageProvider` is resolved lazily on each call because this closure
    // is captured here, BEFORE `bootCoreAddons` registers the storage cap.
    reloadDeployedAddons: async (): Promise<readonly string[]> => {
      const before = new Set(loadedAddons.keys())
      const storage = capabilityRegistry.getSingleton<IStorageProvider>('storage') ?? undefined
      await loadDeployedAddons(
        broker,
        config.addonsDir,
        config.dataDir,
        loadedAddons,
        storage,
        loggerFactory,
        capabilityRegistry,
      )
      const loaded: string[] = []
      for (const id of loadedAddons.keys()) {
        if (!before.has(id)) loaded.push(id)
      }
      return loaded
    },
    // The reload above changed this node's capability set — re-derive the
    // manifest from the live registry and re-run the atomic `registerNode`
    // so the hub's `CapRouteResolver` can route to what this node now has.
    // Hung on the existing `$agent.reload` trigger; no timer (D3).
    reconcileNodeRegistration: () => {
      registration.trigger('addons reloaded')
    },
    // The hub saw this node (re)connect and asks for its capability set —
    // the hub may have dropped it on a disconnect this agent never saw.
    requestRegistration: () => {
      registration.trigger('the hub asked')
    },
    // D3 subtree aggregation: when a group-runner child delivers its manifest
    // via `$agent.registerNode`, merge it into the local subtree registry and
    // immediately re-register the complete union with the hub.
    onChildRegistered: (params: RegisterNodeParams): void => {
      subtree.registerNode(params)
      registration.trigger(`child ${params.nodeId} registered`)
    },
    installFromNpm: async (pkg, version) => {
      await installer.install(pkg, version)
    },
    // #17: deployed bundles go through the installer's full post-install
    // (manifest strip + runtime deps + native deps + atomic swap) instead of
    // the bare tar swap that shipped addons without their node_modules.
    installBundleTgz: (tgzPath) => installer.installFromTgz(tgzPath),
    // `$agent.undeploy` refuses what this node bootstraps itself, and drops the
    // group-runner cap proxies it removes (registered by
    // `registerGroupRunnerProviders`, ownerless — so a plain unregister owns them).
    bootstrapPackages: new Set([
      '@camstack/system',
      '@camstack/addon-agent-ui',
      ...AddonInstaller.AGENT_PACKAGES,
    ]),
    unregisterProvider: (capName, addonId) => {
      if (capabilityRegistry.hasProvider(capName, addonId)) {
        capabilityRegistry.unregisterProvider(capName, addonId)
      }
    },
  })
  broker.createService(agentServiceSchema)

  // $process service — manages forked child processes (same as hub).
  // Pass the agent's own TCP listen port so spawned addon-runners connect
  // back here instead of falling back to port 6000 (the hub). Bug-4:
  // without this, runners called `$agent.registerNode` through the hub
  // which has no `$agent` service → retry storm (attempt 80+).
  const agentTcpPort = deriveAgentListenPort(broker.nodeID)

  // UDS local transport — the agent hosts a LocalChildRegistry so its
  // forked addon-runners route cap calls over a Unix-domain socket. The
  // broker stays as the no-route fallback. On failure the children fall
  // back to broker-only (no parentUdsPath propagated). See moleculer.service.ts.
  let agentParentUdsPath: string | undefined
  let agentUdsRegistry: LocalChildRegistry | undefined
  /** The agent's cluster bus, set once the broker is started (see `lifecycleEvents` below). */
  let agentLifecycleBus: Pick<IEventBus, 'emit'> | null = null
  try {
    const agentNodeId = broker.nodeID
    // F0 (slice-5 outbound): route a forked child's unowned `ctx.api.<cap>`
    // call from the agent (the parent) instead of throwing UDS_NO_ROUTE. The
    // agent has NO CapRouteResolver — it routes everything to the hub over its
    // own broker — so `getResolver` returns null and the handler uses the
    // broker fallback exclusively. The agent's `broker.call` reaches the hub
    // mesh (and any cluster node) via the same service-discovery + action-name
    // convention the child's brokerTransportLink used before F0. F1+F2 removes
    // the child broker, so the agent must own this outbound path.
    const onUnownedCall = createParentUnownedCallHandler({
      getResolver: () => null,
      broker: broker,
      // The agent's subtree registry — lets the broker fallback pin a
      // device-scoped child call to the owning node instead of load-balancing.
      nodeRegistry: subtree,
      // Hub-local UDS child dispatcher — routes a device-scoped native cap
      // owned by an agent-local child directly over UDS before any broker
      // fallback. Getter: `agentUdsRegistry` is assigned later in this scope,
      // after the handler is constructed.
      getLocalDispatcher: () => agentUdsRegistry ?? null,
      // `nodeIdMode: 'data'` signal: these caps carry `nodeId` as provider
      // DATA (the hub singleton dispatches internally), never a routing pin —
      // suppressing the pin lets the call forward unpinned to the hub's
      // singleton resolution, with `args.nodeId` intact for the provider.
      isDataNodeIdCap: (capName) => DATA_NODEID_CAPS.has(capName),
      // AGENT → HUB forward: a cap no agent-local child owns is routed to the
      // hub's `$hub-cap-fwd.forward`, which runs it through the hub's own
      // routing. Only the hub registers `$hub-cap-fwd`, so the undirected
      // `broker.call` discovers it there (no nodeID pin needed). This is what
      // makes an agent's forked addon reach a hub-hosted cap (`stream-broker`,
      // `settings-store`, …) instead of 30s-deadlining on raw `${cap}.*`
      // discovery (hub-local addon runners expose no Moleculer service).
      forwardToHub: (input) =>
        broker.call(
          HUB_CAP_FWD_ACTION,
          {
            capName: input.capName,
            method: input.method,
            args: input.args,
            ...(input.deviceId !== undefined ? { deviceId: input.deviceId } : {}),
            ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
            // The native-only hint must survive the forward: the agent has no
            // native authority of its own (no CapRouteResolver, no cluster
            // CapabilityRegistry), so the hub answers "native or nothing" on
            // its behalf. Dropping it here would let the hub resolve the cap
            // NAME instead — i.e. the wrapper the caller is trying to skip.
            ...(input.native === true ? { native: true } : {}),
            // WHO is calling: this agent's registry stamped it off the child
            // connection the call arrived on. The hub checks it against this
            // node and hands it to owner-checked caps (the keychain, D787).
            ...(input.callerAddonId !== undefined ? { callerAddonId: input.callerAddonId } : {}),
          },
          { timeout: 60_000 },
        ),
      logger: { warn: (msg) => consoleLogger.warn(`[uds-fallback] ${msg}`) },
    })
    agentUdsRegistry = new LocalChildRegistry({
      server: createLocalTransport().createServer(agentNodeId),
      // `WorkerOnline` / `WorkerOffline` `<agent>/<childId>` for a forked runner
      // (no broker of its own, so no `$node.connected`), on the agent's
      // cluster-broadcasting bus. The bus exists only after `broker.start()`;
      // runners are spawned after it (`loadClusterCapableAddons`), and an
      // event before it is said, never silent.
      lifecycleEvents: {
        parentNodeId: () => agentNodeId,
        emit: (event) => {
          if (agentLifecycleBus === null) {
            consoleLogger.info(
              `runner lifecycle event before the agent bus exists — dropped: ${event.category}`,
            )
            return
          }
          agentLifecycleBus.emit(event)
        },
      },
      // The agent's own id — a cap call pinned to THIS agent (e.g. the
      // benchmark running `pipeline-executor.runPipeline` on the very node it
      // is on) is served by the co-resident sibling instead of being forwarded
      // to the hub (the agent has no CapRouteResolver, and the hub would reject
      // it with "no provider registered" unless it knew the agent hosts the
      // cap). A pin to ANOTHER node still bypasses the sibling → onUnownedCall.
      ownNodeId: agentNodeId,
      onUnownedCall,
      // NO `capUsageObserver` here, deliberately. `getCapUsageRegistry()` is a
      // per-process singleton and the reader (`nodes.getCapUsageGraph`) runs on
      // hub-main; recording in the agent would produce a map nobody ever reads,
      // which is exactly the shape that made this graph return `[]` for
      // months. An agent's addon traffic is a KNOWN blind spot of the graph —
      // see `LocalChildRegistryOptions.capUsageObserver`. The caller identity
      // now survives `$hub-cap-fwd`'s envelope (D787, for the keychain), so
      // the hub could record these edges; nothing does yet.
    })
    await agentUdsRegistry.start()
    // E1: apply child manifest + cleanup from the UDS lifecycle (agent-local children).
    // When a runner connects over UDS, synthesise a RegisterNodeParams for the
    // agent's subtree and trigger upward hub registration — same effect as the
    // `$agent.registerNode` Moleculer RPC path. Idempotent: if the Moleculer path
    // fires first, the subtree's atomic-replace handles the re-registration safely.
    agentUdsRegistry.onChildRegistered((child) => {
      const childNodeId = `${agentNodeId}/${child.childId}`
      const childParams = buildAgentChildUdsManifest(childNodeId, child.childId, child.caps)
      subtree.registerNode(childParams)
      registration.trigger(`child ${childNodeId} connected`)
      consoleLogger.info(`UDS child registered — subtree updated: ${childNodeId}`)
    })
    agentUdsRegistry.onChildGone((childId) => {
      const childNodeId = `${agentNodeId}/${childId}`
      subtree.removeNode(childNodeId)
      registration.trigger(`child ${childNodeId} gone`)
      consoleLogger.info(`UDS child gone — subtree updated: ${childNodeId}`)
    })
    // B2: forward UDS child logs onward to the hub's log-receiver service so
    // they appear in the hub LogManager / admin-UI log stream.
    //
    // The agent has NO local LogManager readable by the admin-UI — all log
    // entries must reach the hub. We re-use the same `log-receiver.ingest`
    // Moleculer call that `HubForwarderDestination` uses for the agent's OWN
    // logs, but preserve the child's original `addonId`/`nodeId`/`tags` so
    // the admin-UI shows the originating addon (not the agent's identity).
    //
    // If the hub is not yet reachable, the call silently fails — the same
    // best-effort semantic as `HubForwarderDestination.forward`. Phase F will
    // retire the broker path once every log source emits over UDS end-to-end.
    agentUdsRegistry.onChildLog((childId, entry) => {
      // Key names and URL credentials redacted before the line leaves this
      // node (D787 §8). The child already scrubbed the values it resolved.
      const raw = udsChildLogToWorkerEntry(childId, entry)
      const workerEntry = {
        ...raw,
        message: redactLogText(raw.message),
        ...(raw.meta !== undefined ? { meta: redactLogMeta(raw.meta) } : {}),
      }
      broker.call('log-receiver.ingest', workerEntry).catch(() => {
        // Hub unreachable or not yet discovered — silently drop.
        // HubForwarderDestination handles the agent's own buffered logs;
        // child UDS logs emitted before hub connection are not buffered here.
      })
    })
    agentParentUdsPath = localEndpointPath(agentNodeId)
    consoleLogger.info(`UDS child registry listening on ${agentParentUdsPath}`)
  } catch (err) {
    consoleLogger.warn(
      `UDS child registry failed to start; children stay broker-only: ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const processServiceSchema = createProcessService(
    broker.nodeID,
    config.dataDir,
    undefined,
    agentTcpPort,
    agentParentUdsPath,
  )
  broker.createService(processServiceSchema)

  // Slice-5, Task 7 — register the agent-side cap-dispatch service so the hub
  // can route `agent-child-forward` cap calls to this agent's UDS children.
  // Registered only when the UDS child registry started successfully; if it
  // didn't start the service would have nothing to forward to.
  //
  // Caps hosted in the agent's OWN main process — core addons such as
  // `platform-probe` and `metrics-provider` register singleton providers in
  // `capabilityRegistry`, NOT as forked UDS children — are exposed via this
  // in-process lookup so hub-dispatched `agent-child-forward` calls resolve to
  // them instead of failing with "no provider". Mirrors the hub's
  // `createInProcessProviderLookup`.
  const agentInProcessLookup: InProcessProviderLookup = (
    capName: string,
  ): InProcessProviderRef | null => {
    const provider = capabilityRegistry.getSingleton<Record<string, unknown>>(capName)
    if (provider === null || provider === undefined) return null
    return {
      invoke: (method: string, args: unknown): Promise<unknown> => {
        const fn = provider[method]
        if (typeof fn !== 'function') {
          return Promise.reject(new Error(`method "${method}" not found on cap "${capName}"`))
        }
        const result: unknown = fn.call(provider, args)
        return Promise.resolve(result)
      },
    }
  }
  registerAgentCapDispatch(broker, agentUdsRegistry, agentInProcessLookup, consoleLogger)

  // $addonHost — REMOVED (Sprint 6). Three-level settings are now
  // exposed per-addon via `settings.*` actions in createAddonService.

  // Register $event-bus BEFORE start so the service subscription
  // is announced during discovery. See addon-context-factory.ts for
  // the rationale — post-start registration propagates via heartbeat
  // and is unreliable for the first ~10s.
  registerEventBusService(broker)

  // Start broker BEFORE bootCoreAddons. Core infra addons (storage,
  // sqlite-settings, ...) run their own BaseAddon.initialize() which
  // calls `ctx.settings.readAddonStore()` on every addon; that call
  // routes through `brokerTransportLink` and would deadline-free poll
  // for the hub's `settings-store.get` service if the broker weren't
  // connected to the mesh yet. Starting the broker first lets service
  // discovery resolve (or time out cleanly via the read-blob fallback)
  // so agent boot completes instead of hanging on the first infra addon.
  await broker.start()

  agentRunnerBootCheck = new RunnerBootCheckService({
    logger: consoleLogger,
    nodeId: config.nodeId,
    planned: () => null,
    listProcesses: async () => {
      // Untyped Moleculer boundary; the process service owns the row shape.
      const rows: readonly RunnerStateRow[] = await broker.call('$process.list', {})
      return rows
    },
  })
  agentRunnerBootCheck.scheduleAfterBoot()
  // Re-evaluate a verdict that still had runners on their way, on each runner state change.
  getBrokerEventBus(broker).subscribe({ category: EventCategory.ProcessStateChanged }, () =>
    agentRunnerBootCheck?.noteRunnerChange(),
  )

  // C2: wire the UDS ↔ Moleculer event bridge so events emitted by UDS
  // children fan to siblings and reach the cluster, and cluster / parent-
  // local events propagate to every UDS child. Inert when agentUdsRegistry
  // was not started (no UDS children). Wired after broker.start() so
  // getBrokerEventBus returns the fully operational shared bus.
  const agentBrokerEventBus = getBrokerEventBus(broker)
  agentLifecycleBus = agentBrokerEventBus
  agentUpdateService.bindAvailability(agentBrokerEventBus, broker.nodeID)
  let udsEventBridgeDispose: (() => void) | null = null
  if (agentUdsRegistry !== undefined) {
    udsEventBridgeDispose = createUdsEventBridge({
      registry: agentUdsRegistry,
      parentBus: agentBrokerEventBus,
      parentNodeId: broker.nodeID,
      // D2: relay to children via the pass-through subscription so the bridge's
      // wildcard does NOT count toward this node's local interest (otherwise the
      // gate could never filter anything).
      subscribePassthrough: (handler) => subscribePassthrough(broker, handler),
    })
    // D2: teach the agent's `$event-bus` inbound handler which cross-node
    // (Moleculer) event categories any of its UDS children actually want, so the
    // agent drops hub-origin categories no local subscriber cares about instead
    // of fanning every category into its bus. Read per-event, so a child
    // (un)subscribing takes effect immediately. Fails OPEN when a child is
    // undeclared (aggregateEventInterest → null).
    const interestRegistry = agentUdsRegistry
    setNodeEventInterest(broker, () => interestRegistry.aggregateEventInterest())
    // D1: answer readiness-snapshot requests from UDS children over the
    // agent's own readiness registry view. The agent hydrates its registry
    // from the hub's `$readiness.getSnapshot` Moleculer action (broker
    // path, intact until Phase F) — its snapshot reflects the hub's
    // authoritative view plus any agent-local readiness events. Children
    // request the snapshot over UDS without an additional Moleculer hop.
    // `getOrInitReadinessRegistry` is the same function addon-context-factory
    // uses, so the shared per-broker instance is returned on the first call
    // and reused on subsequent calls — no separate registry is created.
    // Wired after broker.start() so the broker event bus is operational.
    const agentReadinessRegistry = getOrInitReadinessRegistry(
      broker,
      agentBrokerEventBus,
      consoleLogger,
    )
    agentUdsRegistry.onReadinessSnapshotRequest(() =>
      agentReadinessRegistry.getSnapshotForTransport(),
    )
    // D8 reverse leg: expose THIS agent's readiness snapshot so the hub can
    // snapshot-reconcile agent-origin records on every (re)connect and
    // periodically. Without this, the hub learns agent readiness ONLY from
    // lossy cross-node `system.ready-state` broadcasts — a lost `ready`
    // (2026-07-17 incident) left the hub's authoritative registry stuck on
    // the synthesized `down` forever. Registered under
    // `$agent-readiness` (NOT `$readiness`) so the agent's own unqualified
    // `$readiness.getSnapshot` hub-hydrate call is never shadowed locally.
    broker.createService(
      createReadinessServiceForRegistry(agentReadinessRegistry, AGENT_READINESS_SERVICE_NAME),
    )
  }

  // ── HTTP server (Fastify) — status API + process management + UI ──
  // Started early (before addon boot) so the status page is reachable
  // even while addons are still loading.
  const getBrokerFn = (): ServiceBroker => broker

  // ── Update controls for the agent UI ──────────────────────────────
  // Framework: the LOCAL `AgentUpdateService` — `npm view` + `npm install`
  // straight from the registry, no hub in the path, so an isolated node can
  // repair its own version. Addons: report only (the install is a hub push;
  // see `agent-addon-updates.ts`).
  const updateControls: AgentUpdateControls = {
    server: createAgentServerUpdateControls(agentUpdateService, (message) => {
      // A refused/failed update that logs nothing reads as "never happened".
      consoleLogger.warn(`framework update not applied: ${message}`, {
        tags: { nodeId: config.nodeId },
      })
    }),
    addons: {
      hub: createAgentHubAddonControls({
        nodeId: config.nodeId,
        isPaired: () => isAgentPaired(config.configPath),
        // The mesh channel the agent already holds; the hub names this caller
        // `node:<id>` and answers per its remote privilege grant.
        callHub: (action, params, timeoutMs) =>
          broker.call(action, params, { nodeID: 'hub', timeout: timeoutMs }),
        onProblem: (message) => consoleLogger.warn(message, { tags: { nodeId: config.nodeId } }),
      }),
      getReport: () =>
        buildAgentAddonUpdateReport({
          addonsDir: config.addonsDir,
          ...(process.env['CAMSTACK_NPM_REGISTRY'] !== undefined
            ? { registryUrl: process.env['CAMSTACK_NPM_REGISTRY'] }
            : {}),
          fetchFn: (url) => fetch(url),
          isHubReachable: () => getHubConnectionState() === 'connected',
        }),
    },
  }

  // -- Pairing (D857) -------------------------------------------------------------
  // A hub pairs this agent from outside; the agent installs the certificate only after
  // its own operator confirmed the code. Its pairing state is advertised over mDNS.
  const agentVersion =
    process.env['CAMSTACK_AGENT_APP_VERSION'] ?? agentUpdateService.getRunningRootPackage().version
  const agentMdns = new AgentMdnsAdvertiser({
    publisher: createCiaoPublisher(),
    logger: consoleLogger,
  })
  const advertise = (): void => {
    void agentMdns.sync({
      nodeId: config.nodeId,
      version: agentVersion,
      name: config.name,
      port: config.statusPort ?? 4444,
      state: pairing.state(),
      leafFingerprint: pairedLeafFingerprint(config.configPath),
    })
  }
  const addonsBooted = decideAgentBootMode({ paired: isAgentPaired(config.configPath) }) === 'full'
  // ── Self-update (agent-self-update.ts): keep this closure current with nobody driving it.
  // Unpaired -> npm latest, at boot; paired -> the hub's version, at the first registration ack.
  // Then on the update-check cadence (a periodic check, no retry loop). Lifecycle = respawn (D5).
  const selfUpdatePorts: AgentSelfUpdatePorts = {
    enabled: () => agentSelfUpdateEnabled(process.env),
    isPaired: () => isAgentPaired(config.configPath),
    getHubServerVersion: () => hubServerVersion,
    runningVersion: () => agentUpdateService.getRunningRootPackage().version,
    checkLatest: async () => {
      const check = await agentUpdateService.checkServerUpdate()
      return {
        latestVersion: check.latestVersion,
        error: check.error,
        pendingVersion: check.pendingVersion ?? null,
      }
    },
    apply: async (version) => {
      const result = await agentUpdateService.applyServerUpdate({ version })
      return {
        accepted: result.accepted,
        outcome: result.outcome ?? 'unknown',
        message: result.message,
      }
    },
    log: {
      info: (message) => consoleLogger.info(message, { tags: { nodeId: config.nodeId } }),
      warn: (message) => consoleLogger.warn(message, { tags: { nodeId: config.nodeId } }),
    },
  }
  if (isAgentPaired(config.configPath)) {
    selfUpdateOnFirstAck = () => void runAgentSelfUpdate(selfUpdatePorts)
  } else {
    void runAgentSelfUpdate(selfUpdatePorts)
  }
  const selfUpdateTimer = setInterval(
    () => void runAgentSelfUpdate(selfUpdatePorts),
    DEFAULT_UPDATE_CHECK_INTERVAL_SECONDS * 1000,
  )
  selfUpdateTimer.unref()
  const localPairing = createLocalPairingAnnouncer(config.dataDir, consoleLogger)
  const pairing: AgentPairing = new AgentPairing({
    nodeId: config.nodeId,
    version: agentVersion,
    name: config.name,
    isPaired: () => isAgentPaired(config.configPath),
    install: async (installed) => {
      persistPairing(config.configPath, installed)
      hubConnectionStateOverride = null
      consoleLogger.info('Paired with the hub - reconnecting with the new certificate', {
        meta: { hubUrl: installed.hubUrl, hubAddress: installed.hubAddress },
      })
      // The completion is answered first; the wire is replaced right after.
      const timer = setTimeout(() => {
        if (addonsBooted) {
          void reconnect().then(advertise, advertise)
        } else {
          // Booted unpaired: no addon was started (agent-boot-mode.ts). Relaunch (D5) so
          // the core addons boot with the hub reachable.
          scheduleAgentRestart(consoleLogger, 'paired with the hub', config.dataDir)
        }
      }, 400)
      timer.unref?.()
    },
    log: (message, meta) => consoleLogger.info(`pairing: ${message}`, meta ? { meta } : undefined),
    onStateChange: advertise,
    // The PIN and the agent's own code are shown on THIS machine only (console, 0600 file).
    onLocalSecret: localPairing.onSecret,
    onLocalSecretCleared: localPairing.onCleared,
    onResetCode: localPairing.onResetCode,
  })
  const forgetHubNow = async (why: string): Promise<void> => {
    consoleLogger.warn(`Leaving the hub: ${why}. This agent is unpaired and advertises again`)
    forgetPairing(config.configPath, config.dataDir)
    pairing.noteUnpaired()
    hubConnectionStateOverride = null
    await reconnect().catch((err: unknown) =>
      consoleLogger.error(`reconnect after unpairing failed: ${errMsg(err)}`),
    )
    advertise()
  }
  advertise()

  // A hub that forgot or unpaired this agent refuses its leaf without a word. While paired but not
  // connected, ask the hub whether the leaf is still a member; two CA-signed `revoked` answers in a
  // row discard the pairing, anything else changes nothing (D857, D49).
  const membershipWatch = new AgentMembershipWatch({
    nodeId: config.nodeId,
    isPaired: () => isAgentPaired(config.configPath),
    isConnected: () => getHubConnectionState() === 'connected',
    ask: async () => {
      const identity = readPairedHubIdentity(config.configPath)
      const hubUrl =
        identity?.hubUrl ??
        (identity?.hubAddress != null ? deriveHubUrlFromHubAddress(identity.hubAddress) : undefined)
      if (identity === null || hubUrl === undefined) {
        return { kind: 'unreachable', error: 'no hub address on record' }
      }
      return askHubMembership({
        hubUrl,
        nodeId: config.nodeId,
        certPem: identity.certPem,
        keyPem: identity.keyPem,
        caCertPem: identity.caCertPem,
      })
    },
    onRevoked: (reason) => forgetHubNow(`the hub revoked this agent's certificate (${reason})`),
    log: {
      // The console line has no tag column: the node id rides in the text as well.
      warn: (message, extras) => consoleLogger.warn(`${message} [nodeId=${config.nodeId}]`, extras),
      info: (message, extras) => consoleLogger.info(`${message} [nodeId=${config.nodeId}]`, extras),
    },
  })
  const membershipTimer = setInterval(() => {
    void membershipWatch
      .tick(Date.now())
      .catch((err: unknown) => consoleLogger.warn(`membership check failed: ${errMsg(err)}`))
  }, MEMBERSHIP_TICK_MS)
  membershipTimer.unref()

  void startAgentHttpServer(getBrokerFn, {
    log: {
      info: (message, extras) => consoleLogger.info(message, extras),
      warn: (message, extras) => consoleLogger.warn(message, extras),
      error: (message, extras) => consoleLogger.error(message, extras),
    },
    port: config.statusPort ?? 4444,
    nodeId: config.nodeId,
    dataDir: config.dataDir,
    configPath: config.configPath,
    onReconnect: reconnect,
    pairing,
    onForgetHub: () => forgetHubNow('requested on this agent'),
    getHubConnectionState,
    getMeshTransport: () => (currentMeshTls !== null ? 'tls' : 'clear'),
    updateControls,
    serverVersion: agentUpdateService.getRunningRootPackage().version,
  }).then((listener) => {
    agentHttpListener = listener
  })

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[Agent] Shutting down...')
    // Abort any in-flight upward hub registration retry loop.
    registerAbortController.abort()
    // Dispose the UDS event bridge to remove the parent-bus subscriber and
    // clear the child-event handler, preventing subscriber leaks on shutdown.
    udsEventBridgeDispose?.()
    udsEventBridgeDispose = null
    for (const [, entry] of loadedAddons) {
      if (entry.addon?.shutdown) {
        try {
          await entry.addon.shutdown()
        } catch {
          /* */
        }
      }
    }
    // Withdraw the mDNS advertisement, then stop accepting new HTTP/HTTPS connections before
    // the broker goes away.
    await agentMdns.stop().catch(() => undefined)
    await agentHttpListener?.close().catch(() => undefined)
    await broker.stop()
    process.exit(0)
  }
  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)

  // An unpaired agent has no hub to read settings from (D857): serve pairing only and
  // relaunch after the certificate is installed (D5). See agent-boot-mode.ts.
  if (!addonsBooted) {
    console.log(
      `[Agent] Node "${config.nodeId}" is unpaired - serving pairing only; addons boot after pairing`,
    )
    return
  }

  // ── Phase 1: Load core infrastructure addons (in-process) ──
  // storage + settings + metrics + hub-forwarder (log destination)
  await bootCoreAddons(broker, config, capabilityRegistry, loadedAddons, loggerFactory)

  // Plug every registered `log-destination` provider into the shared
  // LogManager. The LogManager replays its ring buffer to each destination
  // on registration, so boot-time log entries still reach destinations that
  // came up mid-boot (e.g. hub-forwarder arriving after the first logs).
  for (const dest of capabilityRegistry.getCollection<ILogDestination>('log-destination')) {
    agentLogManager.addDestination(dest)
  }

  // Everything downstream reads the resolved infra providers from the
  // capability registry — no hand-curated side-channel.
  const storageProvider = capabilityRegistry.getSingleton<IStorageProvider>('storage') ?? undefined

  // `ctx.api` for every addon is built inside `createAddonContext` from
  // `[localProviderLink, brokerTransportLink(broker)]`. Unresolved calls
  // route via Moleculer to the hub (or any other node hosting the cap).
  // No separate hub WSS client, no `CAMSTACK_HUB_API_URL` — all cross-node
  // traffic rides the broker mesh.

  // ── Phase 1.5: Load cluster-capable addon packages (forkable → child process) ──
  await loadClusterCapableAddons(broker, config, capabilityRegistry, loadedAddons)

  // ── Phase 2: Load deployed addons (from hub $agent.deploy) ──
  await loadDeployedAddons(
    broker,
    config.addonsDir,
    config.dataDir,
    loadedAddons,
    storageProvider,
    loggerFactory,
    capabilityRegistry,
  )

  // ── D3: Fire the initial upward hub registration carrying the agent's
  // complete in-process manifest (+ any children that already registered).
  // Group-runner children call `$agent.registerNode` and trigger a re-fire
  // via `onChildRegistered`; every hub connection re-fires it
  // (`registration.onHubConnected`), and so does the hub's ask.
  registration.trigger('boot')

  // Fire `onHubReachable()` on every in-process addon as soon as the hub
  // node connects to our broker — this is the safe point for ctx.api.* calls
  // into hub-provided capabilities. Forked children get the same hook via
  // `process-runner.ts`.
  let hubReachableFired = false
  broker.localBus.on('$node.connected', (data: unknown) => {
    const node = (data as { node?: { id?: string } }).node
    if (node?.id !== 'hub') return
    // Hub connected — its view of this agent was reset, so the full manifest goes again.
    // (A stale `certificate-rejected` clears on the registration's ack.)
    registration.onHubConnected()
    if (hubReachableFired) return
    hubReachableFired = true
    for (const [, entry] of loadedAddons) {
      if (!entry.addon || typeof entry.addon.onHubReachable !== 'function') continue
      Promise.resolve(entry.addon.onHubReachable()).catch((err: unknown) => {
        console.error(`[Agent] ${entry.id} onHubReachable() threw:`, err)
      })
    }
  })

  console.log(
    `[Agent] Node "${config.nodeId}" (name="${config.name}") ready — ${loadedAddons.size} addon(s) loaded`,
  )
}

// ---------------------------------------------------------------------------
// Phase 1: Boot core addons (storage, settings, metrics — NO winston)
// ---------------------------------------------------------------------------

// Core infra addons to load on agent — every infra capability the hub boots
// EXCEPT `data-store-provider`. An agent has no store of its own: its data door
// forwards to the hub (`hub-settings-forward.ts`), so booting `sqlite-settings`
// here would only open a database nothing reads. See
// `agent-infra-capabilities.ts` for the measurement behind that and for the
// one-env-var rollback (`CAMSTACK_AGENT_LOCAL_DATA_STORE=1`).
const AGENT_INFRA = resolveAgentInfraCapabilities(process.env)

async function bootCoreAddons(
  broker: ServiceBroker,
  config: { dataDir: string; addonsDir: string },
  registry: CapabilityRegistry,
  loadedAddons: Map<string, LoadedAddonEntry>,
  loggerFactory: (addonId: string) => IScopedLogger,
): Promise<void> {
  // Builtins come from the CLOSURE this process is running, exactly as the hub
  // has done since 2026-07-18 — never from a `<addonsDir>/@camstack/system`
  // copy, which nothing refreshes and which therefore drifts (both agents were
  // 17 versions behind on 2026-08-11). `planAgentAddonScan` owns the decision
  // and the fallback; see `addon-scan.ts`. Non-framework infra providers
  // (e.g. `@camstack/addon-platform-probe-native`) still come from the scan.
  const closureSystemDir = resolveHubClosurePackageDir(BUILTINS_PACKAGE)
  if (closureSystemDir === null) {
    // Louder than the hub's warn: on an agent the builtins ARE the infra, so
    // this is pre-fatal. Boot continues to the D87 guard, which names every
    // required cap it could not resolve.
    console.error(
      `[Agent] ${BUILTINS_PACKAGE} not resolvable from the running closure — ` +
        'falling back to the addon-root copy, if there is one',
    )
  }
  const packageDirs = planAgentAddonScan(config.addonsDir, closureSystemDir)
  if (packageDirs.length === 0) {
    console.warn('[Agent] No addon packages found — running without infrastructure addons')
    return
  }

  console.log(`[Agent] Scanning ${packageDirs.length} addon package(s) for infra providers`)
  const loader = new AddonLoader()
  for (const dir of packageDirs) {
    try {
      await loader.loadFromAddonDir(dir)
    } catch (err) {
      console.warn(`[Agent] Failed to scan ${dir}: ${errMsg(err)}`)
    }
  }

  // Resolution is per-CAPABILITY (the guard names every missing required
  // cap), initialization is per-ADDON: since D44 one addon legitimately
  // serves several infra caps (`storage-orchestrator` owns both `storage`
  // and `settings-store`), and initializing it once per capability
  // re-registers the same provider — a boot abort by the registry's own
  // double-registration error. That combination took both agents down on
  // 2026-08-08 the moment D87 promoted infra failures to fatal. The plan
  // makes the dedupe explicit and testable (see `infra-boot-plan.ts`).
  const byId = new Map(loader.listAddons().map((a) => [a.declaration.id, a]))
  const plan = planInfraBoot(
    loader.listAddons().map((a) => ({
      id: a.declaration.id,
      capabilities: (a.declaration.capabilities ?? []).map((c) =>
        typeof c === 'string' ? c : c.name,
      ),
    })),
    AGENT_INFRA,
  )
  const resolutions: InfraResolution[] = planToResolutions(plan)

  for (const step of plan) {
    if (step.addonId === null) {
      // Say it per-capability (an OPTIONAL miss is the only thing this line
      // will ever report given the guard below); the required ones abort
      // boot together after the pass.
      console.error(`[Agent] Infrastructure addon for "${step.capName}" not found`)
      continue
    }
    if (!step.initialize) {
      // Served by an addon an earlier capability already booted — the
      // entry exists so a deployment missing it fails loudly, not to boot
      // the addon twice.
      console.log(
        `[Agent] Infra capability "${step.capName}" served by already-booted "${step.addonId}"`,
      )
      continue
    }
    const addon = byId.get(step.addonId)
    if (!addon) continue

    const addonId = addon.declaration.id
    try {
      const instance = new addon.addonClass()
      // Seed ctx.kernel.storage from whatever storage provider is already
      // in the registry (the storage addon declares itself before the
      // addons that depend on it per AGENT_INFRA order).
      const storageProvider = registry.getSingleton<IStorageProvider>('storage') ?? undefined
      const context = await createAddonContext(broker, addon.declaration, config.dataDir, {
        storageProvider,
        addonConfig: { rootPath: config.dataDir },
        createLogger: loggerFactory,
        capabilityRegistry: registry,
        // Feed the storage-orchestrator its first-boot seed declarations
        // (addons-data:default, models:default, …). Without this the agent's
        // sqlite-settings aborts boot: "No default storage location
        // configured for type addons-data" → fatal crash-loop.
        listStorageLocationDeclarations: () => loader.listStorageLocationDeclarations(),
      })

      const initResult = normalizeAddonInitResult(await instance.initialize(context))

      for (const reg of initResult?.providers ?? []) {
        const capName = reg.capability.name
        registry.registerProvider(capName, addonId, reg.provider)
        // Also register in the per-broker context registry
        context.registerProvider(capName, reg.provider)
      }

      loadedAddons.set(addonId, {
        id: addonId,
        status: 'running',
        version: addon.declaration.version,
        packageName: addon.packageName,
        packageVersion: addon.packageVersion,
        addon: instance,
      })

      console.log(`[Agent] Core addon "${addonId}" initialized`)
    } catch (err) {
      const msg = errMsg(err)
      console.error(`[Agent] Failed to initialize core addon "${addonId}": ${msg}`)
      if (step.required) {
        throw new Error(`Required infrastructure addon "${addonId}" failed: ${msg}`, { cause: err })
      }
    }
  }

  // A required infra capability with NO addon at all is strictly worse than
  // one whose addon threw (which already aborted above) — and it used to be
  // the SILENT branch. Abort here instead of booting a node that cannot
  // store, configure or probe itself and whose manifest then makes every hub
  // routing decision about it wrong. See `infra-boot-guard.ts`.
  assertRequiredInfraResolved(resolutions, config.addonsDir)
}

// ---------------------------------------------------------------------------
// Phase 1.5: Load cluster-capable addon packages
// ---------------------------------------------------------------------------

async function loadClusterCapableAddons(
  broker: ServiceBroker,
  config: { dataDir: string; addonsDir: string },
  capabilityRegistry: CapabilityRegistry,
  loadedAddons: Map<string, LoadedAddonEntry>,
): Promise<void> {
  // Builtins are in-process infra, never group-spawned, and they come from the
  // closure — so the addon-root copy is skipped here too. Leaving it in would
  // import a stale entry module during the scan below, which is the whole thing
  // the single-copy collapse removes. The closure dir is deliberately NOT added:
  // adding it would newly expose `hub-forwarder` / `platform-probe` (the only
  // builtins carrying `execution`) as spawn candidates.
  const addonPackageDirs = resolveAddonPackageDirs(config.addonsDir, systemSkipList())
  if (addonPackageDirs.length === 0) return

  // ── Phase 0 (cross-package): collect every group-eligible addon
  //     across ALL package dirs FIRST so we issue exactly one
  //     `$process.spawnGroup` per group. Doing this inside the per-dir
  //     loop spawned the same group multiple times — Moleculer rejected
  //     subsequent attempts with "already running" and the surviving
  //     subprocess only had the first dir's subset of addons.
  const allGroupCandidates: GroupCandidate[] = []
  // Loaders are reused below for the per-addon legacy path; cache them
  // so each dir is parsed once.
  const dirToLoader = new Map<string, AddonLoader>()

  for (const dir of addonPackageDirs) {
    const loader = new AddonLoader()
    try {
      await loader.loadFromAddonDir(dir)
    } catch (err) {
      console.warn(`[Agent] Skipping ${dir}: ${errMsg(err)}`)
      continue
    }
    dirToLoader.set(dir, loader)

    for (const registered of loader.listAddons()) {
      if (loadedAddons.has(registered.declaration.id)) continue
      if (registered.declaration.execution === undefined) continue
      const placement = resolveAddonPlacement(registered.declaration)
      if (placement === 'hub-only') continue
      allGroupCandidates.push({
        groupId: resolveRunnerId(registered.declaration, registered.declaration.id),
        addonId: registered.declaration.id,
        addonDir: dir,
        version: registered.declaration.version ?? '0.0.0',
        packageName: registered.packageName,
        packageVersion: registered.packageVersion,
        capabilities: registered.declaration.capabilities ?? [],
      })
    }
  }

  if (allGroupCandidates.length > 0) {
    const grouped = new Map<string, GroupCandidate[]>()
    for (const c of allGroupCandidates) {
      const arr = grouped.get(c.groupId) ?? []
      arr.push(c)
      grouped.set(c.groupId, arr)
    }
    for (const [groupId, addons] of grouped) {
      try {
        await broker.call('$process.spawnRunner', {
          runnerId: groupId,
          addons: addons.map((a) => ({
            addonId: a.addonId,
            addonDir: a.addonDir,
          })),
        })
        // Shared with the reload path (`ensureGroupRunner`) so the boot and
        // reload registrations can never drift — the drift was the in-process
        // reload-wedge's root cause.
        registerGroupRunnerProviders({ broker, capabilityRegistry, loadedAddons }, addons)
        console.log(
          `[Agent] Group "${groupId}" spawned with ${addons.length} addon(s): ${addons.map((a) => a.addonId).join(', ')}`,
        )
      } catch (err) {
        const msg = err instanceof Error ? (err.stack ?? err.message) : String(err)
        console.error(`[Agent] Failed to spawn group "${groupId}": ${msg}`)
        for (const a of addons) {
          loadedAddons.set(a.addonId, { id: a.addonId, status: 'error' })
        }
      }
    }
  }

  // Diagnostic — list addons that exist in the agent's package dir but
  // were filtered out by Phase 0 (placement=hub-only or no execution).
  for (const dir of addonPackageDirs) {
    const loader = dirToLoader.get(dir)
    if (!loader) continue
    for (const registered of loader.listAddons()) {
      const addonId = registered.declaration.id
      if (loadedAddons.has(addonId)) continue
      if (!isDeployableToAgent(registered.declaration)) continue
      console.warn(
        `[Agent] Addon "${addonId}" is deployable but missing from any spawned group — verify package.json execution field`,
      )
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Load deployed addons (pushed from hub via $agent.deploy)
// ---------------------------------------------------------------------------

async function loadDeployedAddons(
  broker: ServiceBroker,
  addonsDir: string,
  dataDir: string,
  loadedAddons: Map<string, LoadedAddonEntry>,
  storageProvider: IStorageProvider | undefined,
  loggerFactory: (addonId: string) => IScopedLogger,
  capabilityRegistry?: CapabilityRegistry,
): Promise<void> {
  if (!fs.existsSync(addonsDir)) return

  // Discover deployable addons by reading each package's MANIFEST
  // (package.json `camstack.addons[]`) — NOT by importing the entry module.
  // Importing heavy native addon entries (node-av / onnxruntime bridge / …) on
  // the agent MAIN thread is what wedged `$agent.reload` and dropped the node
  // from topology. A group-runner addon only needs its declaration to be
  // (re)dispatched to a subprocess, which loads the real module itself.
  // Same skip: a `$agent.deploy` of `@camstack/system` still lands bytes in the
  // addon root, but a reload must not adopt them over the closure.
  const packageDirs = resolveAddonPackageDirs(addonsDir, systemSkipList())
  const groupCandidates: GroupCandidate[] = []
  // Dirs holding a deployable NON-group addon — and ONLY these — need the
  // importing loader. None exist under the default `hub-only` placement
  // (deployable ⟹ cluster-capable), so the heavy import path is never taken.
  const inProcessDirs = new Set<string>()

  for (const dir of packageDirs) {
    const manifest = readPackageManifestAddons(dir)
    if (!manifest) continue
    for (const decl of manifest.declarations) {
      const addonId = decl.id
      if (loadedAddons.has(addonId)) continue
      if (!isDeployableToAgent(decl)) continue

      if (isGroupRunnerAddon(decl)) {
        groupCandidates.push({
          groupId: resolveRunnerId(decl, addonId),
          addonId,
          addonDir: dir,
          version: decl.version ?? '0.0.0',
          packageName: manifest.packageName,
          packageVersion: manifest.packageVersion,
          capabilities: decl.capabilities ?? [],
        })
      } else {
        inProcessDirs.add(dir)
      }
    }
  }

  // Rare in-process fallback (imports lazily, per-dir, only when such an addon
  // actually exists — never under the current placement model).
  if (inProcessDirs.size > 0) {
    await loadInProcessDeployedAddons(
      broker,
      [...inProcessDirs],
      dataDir,
      loadedAddons,
      storageProvider,
      loggerFactory,
      capabilityRegistry,
    )
  }

  // (Re)spawn each cluster-capable group runner with the current on-disk code —
  // no module import on the main thread.
  if (groupCandidates.length === 0) return
  if (!capabilityRegistry) {
    console.warn(
      `[Agent] ${groupCandidates.length} deployed group addon(s) skipped — no capabilityRegistry passed`,
    )
    return
  }
  const grouped = new Map<string, GroupCandidate[]>()
  for (const c of groupCandidates) {
    const arr = grouped.get(c.groupId) ?? []
    arr.push(c)
    grouped.set(c.groupId, arr)
  }
  const deployLogger = loggerFactory('agent-group-runner')
  for (const [groupId, addons] of grouped) {
    await ensureGroupRunner(
      { broker, capabilityRegistry, loadedAddons, logger: deployLogger },
      groupId,
      addons,
    )
  }
}

/**
 * In-process loader path for deployable NON-group addons (rare). Uses the
 * importing `AddonLoader` — invoked lazily, per-dir, ONLY when such an addon
 * exists. Group-runner addons never reach here, so heavy native modules are
 * never imported on the agent main thread during a reload.
 */
async function loadInProcessDeployedAddons(
  broker: ServiceBroker,
  dirs: readonly string[],
  dataDir: string,
  loadedAddons: Map<string, LoadedAddonEntry>,
  storageProvider: IStorageProvider | undefined,
  loggerFactory: (addonId: string) => IScopedLogger,
  capabilityRegistry?: CapabilityRegistry,
): Promise<void> {
  // Node-local models dir — anchored at this node's data root (CAMSTACK_DATA ??
  // the agent --data dir), never the hub-singleton `storage` cap. Mirrors
  // BaseAddon.resolveModelsDir so addons that read the hint and those that
  // self-resolve agree on one path.
  const modelsDir = path.join(process.env['CAMSTACK_DATA'] ?? dataDir, 'models')
  const contextOptions: AddonContextOptions = {
    storageProvider,
    addonConfig: { modelsDir },
    createLogger: loggerFactory,
    capabilityRegistry,
  }

  for (const dir of dirs) {
    const loader = new AddonLoader()
    try {
      await loader.loadFromAddonDir(dir)
    } catch (err) {
      console.warn(`[Agent] Skipping ${dir}: ${errMsg(err)}`)
      continue
    }
    for (const registered of loader.listAddons()) {
      const addonId = registered.declaration.id
      if (loadedAddons.has(addonId)) continue
      if (!isDeployableToAgent(registered.declaration)) continue
      // Group-runner addons are dispatched to subprocesses by the caller.
      if (isGroupRunnerAddon(registered.declaration)) continue

      try {
        const instance = new registered.addonClass()
        const context = await createAddonContext(
          broker,
          registered.declaration,
          dataDir,
          contextOptions,
        )
        await instance.initialize(context)

        const serviceSchema = createAddonService(instance, registered.declaration)
        broker.createService(serviceSchema)

        loadedAddons.set(addonId, {
          id: addonId,
          status: 'running',
          version: registered.declaration.version,
          packageName: registered.packageName,
          packageVersion: registered.packageVersion,
          addon: instance,
        })

        console.log(`[Agent] Deployed addon "${addonId}" loaded in-process`)
      } catch (err) {
        const msg = errMsg(err)
        console.error(`[Agent] Failed to load deployed addon "${addonId}": ${msg}`)
        loadedAddons.set(addonId, { id: addonId, status: 'error' })
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read the agent's own root package.json version (best-effort). The agent
 * boots the `@camstack/server` closure (via CAMSTACK_ROLE=agent), so its
 * on-disk root package is `@camstack/server`.
 */
function readAgentVersion(): string {
  // package.json sits above `dist/`. Walk up until we hit it.
  const candidates = [
    path.resolve(__dirname, '..', 'package.json'),
    path.resolve(__dirname, '..', '..', 'package.json'),
  ]
  for (const candidate of candidates) {
    try {
      if (!fs.existsSync(candidate)) continue
      const raw = JSON.parse(fs.readFileSync(candidate, 'utf-8')) as {
        name?: string
        version?: string
      }
      if (raw.name === '@camstack/server' && typeof raw.version === 'string') return raw.version
    } catch {
      /* keep searching */
    }
  }
  return 'unknown'
}

/**
 * Skip the addon-root builtins copy — but ONLY when the closure can supply
 * them. Same condition `planAgentAddonScan` applies, kept in one place so the
 * infra scan and the two deployable-addon scans can never disagree about which
 * copy is authoritative.
 */
function systemSkipList(): readonly string[] {
  return resolveHubClosurePackageDir(BUILTINS_PACKAGE) === null ? [] : [BUILTINS_PACKAGE]
}

// ---------------------------------------------------------------------------
// E1 helper — agent-local UDS child manifest adaptation
// ---------------------------------------------------------------------------

/**
 * Adapt a child's UDS `ChildCapDescriptor[]` into a `RegisterNodeParams`
 * for the agent's subtree HubNodeRegistry.
 *
 * Multi-addon manifest support (co-location): descriptors are grouped by the
 * `addonId` each one carries, producing one manifest entry per hosted addon —
 * a GROUPED runner (`execution.group`) registers each addon's caps under its
 * REAL addon id instead of collapsing them under a synthetic
 * `addonId = childId` (the group name). A legacy child that omits `addonId`
 * falls back to `childId` — identical to the historical single-addon
 * behaviour (childId = runnerId = addonId when no group is declared).
 * Mirrors the hub's `buildChildUdsManifest`.
 *
 * Only system (non-device-scoped) caps go into `addons`; device-scoped native
 * caps arrive on a later re-handshake via the Moleculer path.
 */
function buildAgentChildUdsManifest(
  nodeId: string,
  childId: string,
  caps: readonly ChildCapDescriptor[],
): RegisterNodeParams {
  const capsByAddon = new Map<string, Set<string>>()
  for (const cap of caps) {
    if (cap.deviceId !== undefined) continue
    const addonId = cap.addonId ?? childId
    const set = capsByAddon.get(addonId) ?? new Set<string>()
    set.add(cap.capName)
    capsByAddon.set(addonId, set)
  }
  if (capsByAddon.size === 0) {
    capsByAddon.set(childId, new Set<string>())
  }
  const addons: readonly RegisteredAddonManifest[] = [...capsByAddon.entries()].map(
    ([addonId, capNames]) => ({ addonId, capabilities: [...capNames] }),
  )
  return { nodeId, addons }
}

export { startAgent }
