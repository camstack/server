/* eslint-disable @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access -- pre-existing lint debt across this 800-line provider-factory module. The flagged sites delegate into Moleculer/EventBus/IntegrationRegistry surfaces typed as `unknown` to break circular dependencies; runtime contracts are validated by the cap-mount-helper layer above. Tracked separately. */
/**
 * Capability provider factories for the Phase E core caps —
 * `system`, `network-quality`, `toast`, `nodes`, `integrations`,
 * `addons`. Each factory builds a fresh provider object that
 * fulfils the cap's `InferProvider<...>` contract by delegating
 * to the existing backend services.
 *
 * Why factories instead of static singletons?
 *   - `addons.custom` needs per-request `ctx.user` for per-action
 *     auth checks. The cap-router codegen already passes `ctx`
 *     into `getProvider(ctx)`, so closing over it is cheap and
 *     keeps the auth surface tight.
 *   - The other caps don't need ctx, but we keep the signature
 *     uniform for symmetry.
 *
 * No addon "owns" these surfaces — they manage cluster state
 * (cluster topology, integrations, addon packages) or expose
 * server-level singletons (toast bus, network-quality tracker,
 * feature flags + retention controls).
 *
 * Phase E (2026-05-06): replaces the hand-written core routers in
 * `server/backend/src/api/core/{system,network-quality,toast,
 * nodes,integrations,addons}.router.ts`.
 */

import { readIntegrationSettings, writeIntegrationSettings } from './integration-secrets'
import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import type {
  CapabilityRegistry,
  CustomActionRegistry,
  MeshTransport,
  NotificationService,
  ToastService,
} from '@camstack/system'
import {
  asBrokerLike,
  getCapUsageRegistry,
  getLoggingGate,
  getProcessNodeMeshTransport,
  IntegrationRegistry,
  type BrokerLike,
} from '@camstack/system'
import type {
  SecretsAccess,
  AgentListItem,
  IAddonSettingsProvider,
  CapabilityMethodAuth,
  IAddonsProvider,
  IAnalysisDataPersistence,
  IBrokerProvider,
  IConnectionTestProvider,
  IDeviceProvider,
  IIntegrationRegistry,
  IIntegrationsProvider,
  INetworkQualityProvider,
  INodesProvider,
  Integration,
  IntegrationTestConnectionStatus,
  IScopedLogger,
  ISettingsStoreProvider,
  ISystemProvider,
  IToastProvider,
  Toast,
  TopologyNode,
} from '@camstack/types'
import { collectKeychainStoredKeys, EventCategory, errMsg } from '@camstack/types'
import { TRPCError } from '@trpc/server'
import { planDeleteTimeStamps } from '../../boot/integration-id-backfill'
import type { AddonPackageService } from '../../core/addon/addon-package.service'
import { SYSTEM_PACKAGE } from '../../core/addon/addon-package.service.js'
import type { AddonRegistryService } from '../../core/addon/addon-registry.service'
import {
  type AddonUninstallSeam,
  type AgentStatusAddonRow,
  listInstallations,
  PackageProtectedError,
  uninstallPackage,
} from '../../core/addon/addon-uninstall.js'
import { isAgentTrackedPackage } from '../../core/agent/agent-desired-set'
import type { AgentRegistryService } from '../../core/agent/agent-registry.service'
import type { ConfigService } from '../../core/config/config.service'
import type { EventBusService } from '../../core/events/event-bus.service'
import type { FeatureService } from '../../core/feature/feature.service'
import { getLifecycleRunner } from '../../core/lifecycle/lifecycle-runner.singleton.js'
import type { LoggingService } from '../../core/logging/logging.service'
import type { MoleculerService } from '../../core/moleculer/moleculer.service'
import type { NetworkQualityService } from '../../core/network/network-quality.service'
import type { ServerUpdateService } from '../../core/server-update/server-update.service'
import {
  AGENT_STATUS_TIMEOUT_MS,
  fetchAgentInstalledPackages,
} from '../../core/updates/agent-installed-packages.js'
import type { HttpRequestCensus } from '../trpc/http-request-census.js'
import { getHttpRequestCensus } from '../trpc/http-request-census.singleton.js'
import type { TrpcContext } from '../trpc/trpc.context.js'
import { writeCollectionToggle } from './capability-preference-writes.js'
import { buildFailureContributionPlane } from './failure-contributions.js'
import { buildLoadContributionPlane } from './load-contributions.js'
import { buildLogChannelPlane, LoggingSettingsService } from './logging-settings.js'
import { RequestCensusService } from './request-census-settings.js'
import { ServerNameReader } from './server-name.js'
import { type SettingsStoreGateway, SiteLocationService } from './site-location.js'

// ── system ──────────────────────────────────────────────────────────

function getRetention(registry: CapabilityRegistry | null) {
  return (
    registry?.getSingleton<IAnalysisDataPersistence>('analysis-data-persistence')?.retention ?? null
  )
}

export function buildSystemProvider(
  feature: FeatureService,
  registry: CapabilityRegistry | null,
  logger?: IScopedLogger,
  census: HttpRequestCensus = getHttpRequestCensus(),
): ISystemProvider {
  const siteLocation = buildSiteLocationService(registry, logger)
  const store = buildSettingsStoreGateway(registry)
  const serverName = new ServerNameReader({ store, ...(logger !== undefined ? { logger } : {}) })
  const requestCensus = new RequestCensusService({
    census,
    store,
    ...(logger !== undefined ? { logger } : {}),
  })
  // ONE write authority over levels and diagnostic windows. `requestCensus` is
  // reachable only through this service now — `system.setRequestCensus` was
  // retired on 2026-08-27 precisely so two writes cannot disagree about the
  // same window (D245).
  // The channels themselves are DECLARED by the addons that own them and
  // reached through the registry's per-provider proxies — hub-main never keeps
  // a hand-written list, which would rot at the first addon that adds one.
  const channels = buildLogChannelPlane(
    { entries: () => registry?.getCollectionEntries('log-channels') ?? [] },
    (addonId, phase, error) => {
      logger?.warn('log-channels provider unreachable', { meta: { addonId, phase, error } })
    },
  )
  // Every addon's OWN reported cost, assembled by enumeration. Nothing here
  // knows which pid belongs to which camera — the addon that spawned the child
  // does, and it is the one that says so.
  const loadContributions = buildLoadContributionPlane(
    { entries: () => registry?.getCollectionEntries('load-contribution') ?? [] },
    (addonId, error) => {
      logger?.warn('load-contribution provider unreachable', { meta: { addonId, error } })
    },
  )
  // Every addon's OWN reported losses, per camera, with the denominator
  // attached. Same enumeration, same reason: the addon that owns the failing
  // path is the only thing that knows which camera it lost work for.
  const failureContributions = buildFailureContributionPlane(
    { entries: () => registry?.getCollectionEntries('failure-contribution') ?? [] },
    (addonId, error) => {
      logger?.warn('failure-contribution provider unreachable', { meta: { addonId, error } })
    },
  )
  const loggingSettings = new LoggingSettingsService({
    store,
    gate: getLoggingGate(),
    requestCensus,
    channels,
    ...(logger !== undefined ? { logger } : {}),
  })
  return {
    info: async () => ({ ...feature.getManifest(), serverName: await serverName.read() }),
    health: async () => ({ status: 'ok' as const, uptime: process.uptime() }),
    featureFlags: async () => feature.getManifest(),
    networkAddresses: async () => {
      const ifaces = os.networkInterfaces()
      const result: Array<{ name: string; address: string; family: string; internal: boolean }> = []
      for (const [name, addrs] of Object.entries(ifaces)) {
        for (const addr of addrs ?? []) {
          result.push({
            name,
            address: addr.address,
            family: addr.family,
            internal: addr.internal,
          })
        }
      }
      return result
    },
    getLoadContributions: async () => loadContributions.contributions(),
    getFailureContributions: async () => failureContributions.contributions(),
    getRetentionConfig: async () => getRetention(registry)?.getConfig() ?? null,
    setRetentionConfig: async (input) => {
      getRetention(registry)?.setConfig(input)
      return null
    },
    forceRetentionCleanup: async () => {
      await getRetention(registry)?.forceCleanup()
    },
    getSiteLocation: async () => siteLocation.get(),
    setSiteLocation: async (input) => siteLocation.set(input),
    detectSiteLocation: async () => siteLocation.detect(),
    getRequestCensus: async () => requestCensus.status(),
    getLoggingSettings: async (input) =>
      loggingSettings.get(input.scopeNodeId, input.scopeComponent),
    setLoggingSettings: async (input) =>
      loggingSettings.set(input.patch, input.scopeNodeId, input.scopeComponent),
  }
}

/**
 * Site location, backed by the `system-settings` collection through the
 * hub-resident `settings-store` CAP, resolved lazily from the registry —
 * the cap boots after this provider is constructed, and there is NO
 * `settings-store.*` Moleculer action to call (that path returned
 * "Service 'settings-store.get' is not found" in production while the
 * tests' fake gateway hid it).
 *
 * Without a registry (unit tests that build the provider bare) the store
 * fails closed: reads throw, so the derivation cannot fire and cannot
 * invent a location out of a missing dependency.
 */
function buildSiteLocationService(
  registry: CapabilityRegistry | null,
  logger: IScopedLogger | undefined,
): SiteLocationService {
  return new SiteLocationService({
    store: buildSettingsStoreGateway(registry),
    ...(logger !== undefined ? { logger } : {}),
  })
}

/**
 * The two settings-store calls a hub-side service needs, resolved LAZILY from
 * the capability registry.
 *
 * Lazy because the cap boots after these providers are constructed, and there
 * is NO `settings-store.*` Moleculer action to call instead (that path
 * returned "Service 'settings-store.get' is not found" in production while the
 * tests' fake gateway hid it). Without a registry the gateway fails closed:
 * every call throws, so a caller cannot mistake a missing dependency for an
 * empty row.
 */
export function buildSettingsStoreGateway(
  registry: CapabilityRegistry | null,
): SettingsStoreGateway {
  const resolve = (): ISettingsStoreProvider => {
    const provider = registry?.getSingleton<ISettingsStoreProvider>('settings-store') ?? null
    if (provider === null) throw new Error('settings-store unavailable: cap not registered yet')
    return provider
  }
  return {
    get: async (input) => resolve().get(input),
    set: async (input) => {
      await resolve().set(input)
    },
  }
}

// ── network-quality ─────────────────────────────────────────────────

export function buildNetworkQualityProvider(nq: NetworkQualityService): INetworkQualityProvider {
  return {
    getDeviceStats: async (input) => nq.getDeviceStats(input.deviceId),
    getAllStats: async () => nq.getAllStats(),
    reportClientStats: async (input) => {
      nq.reportClientStats(input.deviceId, {
        rttMs: input.rttMs,
        jitterMs: input.jitterMs,
        estimatedBandwidthKbps: input.estimatedBandwidthKbps,
        packetLossPercent: input.packetLossPercent,
        ...(input.downlinkMbps !== undefined ? { downlinkMbps: input.downlinkMbps } : {}),
        ...(input.downlinkAgeMs !== undefined ? { downlinkAgeMs: input.downlinkAgeMs } : {}),
      })
    },
  }
}

// ── toast ───────────────────────────────────────────────────────────
//
// Per-request factory: each subscription opens its own connectionId.
// The factory captures `ctx.user.id` so the underlying ToastService
// can scope deliveries (broadcast vs. per-user). The cap defines
// `onToast` as a subscription — the codegen wires it through the
// `iterableSubscription` adapter and pushes raw `Toast` payloads.

export function buildToastProvider(
  toastService: ToastService | null,
  ctx: TrpcContext,
): IToastProvider {
  return {
    onToast: (_input, push) => {
      if (!toastService) return () => {}
      const userId = ctx.user?.id ?? 'anonymous'
      const connectionId = randomUUID()
      const unsubscribe = toastService.subscribe(connectionId, userId, (toast: Toast) =>
        push(toast),
      )
      return unsubscribe ?? (() => {})
    },
  }
}

// ── nodes ───────────────────────────────────────────────────────────

interface SubProcessLite {
  readonly pid: number
  readonly name: string
  readonly state: string
  readonly cpuPercent: number
  readonly memoryRss: number
  readonly uptimeSeconds: number
  readonly addonIds?: readonly string[]
  readonly groupId?: string | null
}

/** `{ meshTransport }` for an online agent, `{}` when the hub cannot tell. */
function meshTransportField(nodeId: string): { readonly meshTransport?: MeshTransport } {
  const meshTransport = getProcessNodeMeshTransport(nodeId)
  return meshTransport === undefined ? {} : { meshTransport }
}

function getLocalIps(): string[] {
  const interfaces = os.networkInterfaces()
  const ips: string[] = []
  for (const ifaces of Object.values(interfaces)) {
    if (!ifaces) continue
    for (const iface of ifaces) {
      if (iface.internal) continue
      ips.push(iface.address)
    }
  }
  return ips
}

/**
 * Pure (well, async) topology computation — same shape returned by the
 * `nodes.topology` cap procedure. Extracted so the topology emitter
 * service can produce identical snapshots without going through tRPC.
 */
/**
 * One topology pass, and the live entries it was projected from.
 *
 * The periodic pass needs both: the rows to push, and the live descriptors to
 * capture durably. Handing the inputs back is what lets
 * `TopologyEmitterService` own the capture WITHOUT a second cluster fan-out
 * (D317) — and what keeps `computeTopology` itself free of any write.
 */
export interface TopologyPass {
  readonly nodes: readonly TopologyNode[]
  /** The live `listNodes()` entries — the periodic pass's capture set. */
  readonly liveNodes: readonly AgentListItem[]
}

/** {@link computeTopology}, keeping the live entries the projection consumed. */
export async function computeTopologyPass(
  agentRegistry: AgentRegistryService,
  addonRegistry?: AddonRegistryService,
  getNodeRootPackage?: NodeRootPackageLookup,
  isNodeRegistered?: NodeRegistrationLookup,
): Promise<TopologyPass> {
  const [nodes, liveNodes] = await computeTopologyInternal(
    agentRegistry,
    addonRegistry,
    getNodeRootPackage,
    isNodeRegistered,
  )
  return { nodes, liveNodes }
}

export async function computeTopology(
  agentRegistry: AgentRegistryService,
  addonRegistry?: AddonRegistryService,
  getNodeRootPackage?: NodeRootPackageLookup,
  isNodeRegistered?: NodeRegistrationLookup,
): Promise<readonly TopologyNode[]> {
  const [nodes] = await computeTopologyInternal(
    agentRegistry,
    addonRegistry,
    getNodeRootPackage,
    isNodeRegistered,
  )
  return nodes
}

/**
 * The `capabilitiesRegistered` field of an ONLINE agent row: whether the hub
 * holds that agent's `registerNode` manifest. Absent for the hub, offline rows
 * and when no lookup is wired.
 */
function registrationField(
  nodeId: string,
  isHub: boolean,
  isOnline: boolean,
  isNodeRegistered: NodeRegistrationLookup | undefined,
): { readonly capabilitiesRegistered?: boolean } {
  if (isHub || !isOnline || isNodeRegistered === undefined) return {}
  return { capabilitiesRegistered: isNodeRegistered(nodeId) }
}

async function computeTopologyInternal(
  agentRegistry: AgentRegistryService,
  addonRegistry?: AddonRegistryService,
  getNodeRootPackage?: NodeRootPackageLookup,
  isNodeRegistered?: NodeRegistrationLookup,
): Promise<readonly [readonly TopologyNode[], readonly AgentListItem[]]> {
  // The live cluster walk and the durable offline-node history read NOTHING
  // from each other, and the history read is one settings-store round trip —
  // measured on the live hub at 14.8–18.3 s while the store is stalled. Awaited
  // one after the other, that made a read cost two store ticks (D317). One
  // wave: the projection below needs both, and neither needs the other.
  const [nodes, history] = await Promise.all([
    agentRegistry.listNodes(),
    agentRegistry.getClusterNodeHistory(),
  ])
  const historyById = new Map(history.map((h) => [h.id, h]))
  const liveIds = new Set(nodes.map((n) => n.info.id))
  const allAddons = addonRegistry?.listAddons() ?? []
  const getInGroupAddonIds = (node: (typeof nodes)[number]): readonly string[] => {
    const subs = (node.subProcesses ?? []) as readonly SubProcessLite[]
    return subs.flatMap((p) => p.addonIds ?? [])
  }
  const addonCaps = new Map<string, readonly string[]>()
  for (const a of allAddons) {
    const id = a.manifest?.id ?? ''
    const caps = a.declaration?.capabilities?.map((c) => (typeof c === 'string' ? c : c.name)) ?? []
    addonCaps.set(id, caps)
  }
  const addonCategory = new Map<string, string>()
  for (const a of allAddons) {
    const id = a.manifest?.id ?? ''
    const category = a.declaration?.category ?? 'system'
    addonCategory.set(id, category)
  }
  const liveNodes: TopologyNode[] = nodes.map((node) => {
    const inGroupAddonIds = new Set(getInGroupAddonIds(node))
    const agentAddonIds: readonly string[] =
      (node as { agentAddons?: readonly string[] }).agentAddons ?? []
    type NodeAddonEntry = { id: string; capabilities: readonly string[]; status: 'running' }
    const allNodeAddons: NodeAddonEntry[] = node.isHub
      ? allAddons.map((a) => {
          const id = a.manifest?.id ?? 'unknown'
          return { id, capabilities: [...(addonCaps.get(id) ?? [])], status: 'running' as const }
        })
      : agentAddonIds.map((addonId) => ({
          id: addonId,
          capabilities: [...(addonCaps.get(addonId) ?? [])],
          status: 'running' as const,
        }))
    const inProcessAddons = allNodeAddons.filter((a) => !inGroupAddonIds.has(a.id))
    const isolatedProcesses = (node.subProcesses ?? []) as readonly SubProcessLite[]
    const mainProcessServices = inProcessAddons.map((a) => ({
      addonId: a.id,
      capabilities: a.capabilities,
      status: a.status,
    }))
    const mainProcess = node.isHub
      ? {
          pid: process.pid,
          name: 'hub (core)',
          state: 'running' as const,
          cpuPercent: node.status?.cpuPercent ?? 0,
          memoryRss: process.memoryUsage().rss,
          uptimeSeconds: Math.floor(process.uptime()),
          services: mainProcessServices,
        }
      : {
          pid: 0,
          name: `${node.info.id} (core)`,
          state: 'running' as const,
          cpuPercent: node.status?.cpuPercent ?? 0,
          // The agent's own process RSS from $agent.status; 0 only for an agent
          // that predates the field.
          memoryRss: node.status?.processRssBytes ?? 0,
          uptimeSeconds: Math.floor((Date.now() - node.connectedSince) / 1000),
          services: mainProcessServices,
        }
    const childProcesses = isolatedProcesses.map((p) => {
      const memberIds = p.addonIds && p.addonIds.length > 0 ? p.addonIds : [p.name]
      return {
        pid: p.pid,
        name: p.name,
        state: p.state,
        cpuPercent: p.cpuPercent,
        memoryRss: p.memoryRss,
        uptimeSeconds: p.uptimeSeconds,
        groupId: p.groupId ?? p.name,
        services: memberIds.map((addonId) => ({
          addonId,
          capabilities: [...(addonCaps.get(addonId) ?? [])],
          status: p.state,
        })),
      }
    })
    // Aggregate node-local addons by category. `allNodeAddons` already
    // contains the per-node addon roster (hub uses every installed
    // addon; agents use their assigned agentAddons subset).
    const byCategory = new Map<
      string,
      {
        category: string
        total: number
        healthy: number
        addons: { id: string; status: string; cpuPercent: number; memoryRss: number }[]
      }
    >()
    const procByAddon = new Map<string, { cpuPercent: number; memoryRss: number; state: string }>()
    for (const p of (node.subProcesses ?? []) as readonly SubProcessLite[]) {
      for (const addonId of p.addonIds ?? []) {
        procByAddon.set(addonId, {
          cpuPercent: p.cpuPercent,
          memoryRss: p.memoryRss,
          state: p.state,
        })
      }
    }
    for (const a of allNodeAddons) {
      const category = addonCategory.get(a.id) ?? 'system'
      const procInfo = procByAddon.get(a.id)
      const entry = byCategory.get(category) ?? { category, total: 0, healthy: 0, addons: [] }
      const status = procInfo?.state ?? a.status
      entry.total += 1
      if (status === 'running') entry.healthy += 1
      entry.addons.push({
        id: a.id,
        status,
        cpuPercent: procInfo?.cpuPercent ?? 0,
        memoryRss: procInfo?.memoryRss ?? 0,
      })
      byCategory.set(category, entry)
    }
    const categoriesProjection = [...byCategory.values()]
    return {
      id: node.info.id,
      name: node.info.name,
      hostname: node.isHub ? os.hostname() : (node.info.hostname ?? node.info.id),
      platform: node.info.platform ?? 'unknown',
      arch: node.info.arch ?? 'unknown',
      cpuModel: node.info.cpuModel ?? null,
      cpuCores: node.info.cpuCores ?? 0,
      memoryMB: node.info.memoryMB ?? 0,
      engines: [...(node.info.pythonRuntimes ?? [])],
      isHub: node.isHub,
      isOnline: node.isOnline !== false,
      cpuPercent: node.status?.cpuPercent ?? 0,
      memoryPercent: node.status?.memoryPercent ?? null,
      uptime: Date.now() - node.connectedSince,
      // Fix (was hardcoded `new Date().toISOString()` — always "now", a bug
      // even for online nodes): report the persisted `lastActive` when we have
      // it, falling back to now only for a node with no history row yet.
      lastSeen: new Date(historyById.get(node.info.id)?.lastActive ?? Date.now()).toISOString(),
      localIps: node.isHub ? getLocalIps() : (node.localIps ?? []),
      addons: allNodeAddons,
      processes: [mainProcess, ...childProcesses],
      categories: categoriesProjection,
      // Runtime-updatable node packages: the node's root-package identity
      // (hub: the running @camstack/server; agents: their registerNode
      // manifest via HubNodeRegistry). Null when unknown.
      rootPackage: getNodeRootPackage?.(node.info.id, node.isHub) ?? null,
      // Mesh mTLS Release A: observed by the hub's transporter (certificate CN),
      // never self-reported by the agent. Hub row and unknown: no badge.
      ...(node.isHub ? {} : meshTransportField(node.info.id)),
      // An agent online in the mesh whose capability registration the hub
      // dropped (a disconnect only the hub saw) is reported, never silently
      // capless (2026-10-14).
      ...registrationField(node.info.id, node.isHub, node.isOnline !== false, isNodeRegistered),
    }
  })

  // A2: union in OFFLINE rows for every persisted node no longer present in the
  // live Moleculer window (or gone entirely after a hub restart). These render
  // straight from the last-known descriptor with live metrics zeroed. Nothing
  // here participates in capability routing — it is purely a topology row.
  const offlineNodes: TopologyNode[] = history
    .filter((persisted) => !liveIds.has(persisted.id))
    .map((persisted) => ({
      id: persisted.id,
      name: persisted.name,
      hostname: persisted.hostname,
      platform: persisted.platform,
      arch: persisted.arch,
      cpuModel: persisted.cpuModel,
      cpuCores: persisted.cpuCores,
      memoryMB: persisted.memoryMB,
      engines: [...persisted.engines],
      isHub: persisted.isHub,
      isOnline: false,
      cpuPercent: 0,
      memoryPercent: null,
      uptime: 0,
      lastSeen: new Date(persisted.lastActive).toISOString(),
      localIps: [...persisted.localIps],
      addons: persisted.addonIds.map((id) => ({
        id,
        capabilities: [...(addonCaps.get(id) ?? [])],
        status: 'stopped' as const,
      })),
      processes: [],
      categories: [],
      rootPackage: null,
    }))

  return [[...liveNodes, ...offlineNodes], nodes]
}

/**
 * The node's runtime-updatable root-package identity for topology rows.
 * `isHub` selects the hub's own running package (the hub never registers
 * with itself); agents resolve from the `registerNode` manifest.
 */
export type NodeRootPackageLookup = (
  nodeId: string,
  isHub: boolean,
) => { readonly name: string; readonly version: string } | null

/** Does the hub hold a `registerNode` manifest for this node? */
export type NodeRegistrationLookup = (nodeId: string) => boolean

/**
 * Build the standard {@link NodeRootPackageLookup}: hub rows come from the
 * running `@camstack/server` package (ServerUpdateService), agent rows from
 * the `registerNode`-fed HubNodeRegistry (via MoleculerService).
 */
export function createNodeRootPackageLookup(
  moleculer: MoleculerService,
  serverUpdate: ServerUpdateService | null,
): NodeRootPackageLookup {
  return (nodeId, isHub) => {
    if (isHub) {
      const running = serverUpdate?.getRunningRootPackage()
      return running === undefined || running.version === null
        ? null
        : { name: running.name, version: running.version }
    }
    return moleculer.getNodeRootPackage(nodeId)
  }
}

export function buildNodesProvider(
  agentRegistry: AgentRegistryService,
  moleculer: MoleculerService,
  addonRegistry?: AddonRegistryService,
  getNodeRootPackage?: NodeRootPackageLookup,
  logger?: IScopedLogger,
): INodesProvider {
  const broker = asBrokerLike(moleculer.broker)
  return {
    topology: async () =>
      computeTopology(agentRegistry, addonRegistry, getNodeRootPackage, (nodeId) =>
        moleculer.isNodeRegistered(nodeId),
      ),
    directory: async () => agentRegistry.listNodeDirectory(),
    deployAddon: async () => {
      // Placeholder — actual deployment orchestration TBD
      return { success: true }
    },
    undeployAddon: async (input) => {
      await broker.call(
        '$agent.undeploy',
        {
          addonId: input.addonId,
        },
        { nodeID: input.nodeId, timeout: 30_000 },
      )
      // Drop it from the node's intended set. Without this the addon back-fill
      // would put the package straight back on the next reconnect — the
      // reconcile converges a node to the roster it last declared, so a
      // deliberate per-node removal has to be recorded as such. This is the
      // operator gesture that shrinks the record; nothing else does.
      await agentRegistry.noteAddonUndeployed(input.nodeId, input.addonId)
      return { success: true }
    },
    restartAddon: async (input) => {
      const isHubLocal = input.nodeId === 'hub' || input.nodeId.startsWith('hub/')
      if (isHubLocal && addonRegistry) {
        const result: unknown = await addonRegistry.restartAddon(input.addonId)
        if (typeof result === 'object' && result !== null && 'success' in result) {
          return result as { success: boolean }
        }
        return { success: true }
      }
      const agentNodeId = input.nodeId.includes('/') ? input.nodeId.split('/')[0]! : input.nodeId
      // Propagate the agent's REAL result instead of a hardcoded success.
      // `$agent.restart` throws on failure (surfaced as a rejected broker.call),
      // but on the happy path it returns the agent's `{ success, addonId, pid }`
      // — honour its `success` flag so a future non-throwing failure is not
      // reported as a phantom success. Mirrors the hub-local branch above.
      const result: unknown = await broker.call(
        '$agent.restart',
        {
          addonId: input.addonId,
        },
        { nodeID: agentNodeId, timeout: 30_000 },
      )
      if (typeof result === 'object' && result !== null && 'success' in result) {
        return { success: (result as { success: boolean }).success }
      }
      return { success: true }
    },
    restartProcess: async (input) => {
      return (await broker.call(
        '$process.restart',
        {
          name: input.processName,
        },
        { nodeID: input.nodeId, timeout: 30_000 },
      )) as { success: boolean; reason?: string }
    },
    restartNode: async (input) => {
      return (await broker.call(
        '$process.restartAll',
        {},
        {
          nodeID: input.nodeId,
          timeout: 60_000,
        },
      )) as { restarted: readonly string[]; failed: readonly string[] }
    },
    shutdownNode: async (input) => {
      if (input.nodeId === 'hub') {
        // A whole-hub shutdown used to be COMPLETELY silent — process.exit(0)
        // with not one log line. On 2026-08-01 the hub container went down
        // cleanly at 15:02:55Z (docker restart policy brought it back 9s
        // later, viewer stalled through the boot) and the initiator was
        // unrecoverable from the logs precisely because this branch said
        // nothing. An operator-facing kill switch logs before it fires.
        logger?.warn('shutdownNode: HUB shutdown requested via API — exiting in 500ms', {
          meta: { nodeId: input.nodeId },
        })
        setTimeout(() => process.exit(0), 500)
        return { success: true }
      }
      await broker.call(
        '$agent.shutdown',
        {},
        {
          nodeID: input.nodeId,
          timeout: 10_000,
        },
      )
      return { success: true }
    },
    renameNode: async (input) => {
      const trimmed = input.name.trim()
      if (input.nodeId === 'hub') {
        const key = `node-display-name:${input.nodeId}`
        await broker.call('settings-store.set', {
          collection: 'system-settings',
          key,
          value: trimmed,
        })
      } else {
        await broker.call(
          '$agent.rename',
          {
            name: trimmed,
          },
          { nodeID: input.nodeId, timeout: 10_000 },
        )
        agentRegistry.updateAgentName(input.nodeId, trimmed)
      }
      return { nodeId: input.nodeId, name: trimmed }
    },
    getNodeAddons: async (input) => {
      // Hub branch: read straight from the local registry. Surfaces every
      // loaded addon with its package name + version so the per-node Addons
      // tab can render the same shape regardless of whether the target is
      // hub or agent.
      if (input.nodeId === 'hub') {
        await addonRegistry?.refreshRunnerStates()
        const rows = addonRegistry?.listAddons() ?? []
        return rows.map((r) => ({
          id: r.manifest.id,
          status: r.process?.state ?? 'unknown',
          version: r.manifest.packageVersion,
          packageName: r.manifest.packageName,
        }))
      }
      // Agent branch: forward to `$agent.status` and pick out its `addons`
      // field. Done as a direct call (not via `agentRegistry`'s cached
      // listing) so the UI always sees fresh data when it opens the tab
      // — the cache otherwise lags the cluster heartbeat interval.
      try {
        const status = await broker.call<{
          addons?: readonly { id: string; status: string; version?: string; packageName?: string }[]
        }>('$agent.status', {}, { nodeID: input.nodeId, timeout: 5_000 })
        type AgentAddonRow = {
          id: string
          status: string
          version?: string
          packageName?: string
        }
        return (status.addons ?? []).map((a: AgentAddonRow) => ({
          id: a.id,
          status: a.status,
          ...(a.version !== undefined ? { version: a.version } : {}),
          ...(a.packageName !== undefined ? { packageName: a.packageName } : {}),
        }))
      } catch {
        return []
      }
    },
    clusterAddonStatus: async () => {
      const hubAddons = addonRegistry?.listAllAddons() ?? []
      const hubMap = new Map(hubAddons.map((a) => [a.manifest.id, a]))

      const nodes = await agentRegistry.listNodes()
      const remoteNodes = nodes.filter((n) => !n.isHub && n.connectedSince > 0)

      const remoteStatuses = await Promise.all(
        remoteNodes.map(async (node) => {
          try {
            const status = (await broker.call(
              '$agent.status',
              {},
              {
                nodeID: node.info.id,
                timeout: 5_000,
              },
            )) as {
              addons?: readonly {
                id: string
                status: string
                version?: string
                packageName?: string
              }[]
            }
            return {
              nodeId: node.info.id,
              name: node.info.name,
              online: true,
              addons: status.addons ?? [],
            }
          } catch {
            return {
              nodeId: node.info.id,
              name: node.info.name,
              online: false,
              addons: [] as readonly {
                id: string
                status: string
                version?: string
                packageName?: string
              }[],
            }
          }
        }),
      )

      type NodeDeployment = {
        nodeId: string
        name: string
        version: string
        status: string
        synced: boolean
      }
      const result: Record<string, { hubVersion: string; nodes: NodeDeployment[] }> = {}

      for (const [addonId, hubAddon] of hubMap) {
        const hubVersion = hubAddon.manifest.packageVersion
        const addonNodes: NodeDeployment[] = [
          { nodeId: 'hub', name: 'hub', version: hubVersion, status: 'running', synced: true },
        ]

        for (const remote of remoteStatuses) {
          const remoteAddon = remote.addons.find((a) => a.id === addonId)
          if (remoteAddon) {
            const remoteVersion = remoteAddon.version ?? 'unknown'
            addonNodes.push({
              nodeId: remote.nodeId,
              name: remote.name,
              version: remoteVersion,
              status: remote.online ? remoteAddon.status : 'offline',
              synced: remoteVersion === hubVersion,
            })
          }
        }

        result[addonId] = { hubVersion, nodes: addonNodes }
      }

      return result
    },
    /**
     * Observed caller → provider → cap edges over the last `windowSeconds`.
     *
     * **Read the blind spots before drawing a conclusion.** This reads
     * hub-main's `CapUsageRegistry`, written by the hub's `LocalChildRegistry`
     * on every `cap-call-out` a hub-local forked addon sends. It therefore does
     * NOT contain: hub-main → hub-main in-process calls (one shared `ctx.api`
     * client, no per-caller identity), a runner's own co-located calls, or any
     * traffic originating on an agent. An edge missing here means "not seen on
     * this plane", never "did not happen" — the full list is on
     * `LocalChildRegistryOptions.capUsageObserver`.
     */
    getCapUsageGraph: async (input) => {
      const reg = getCapUsageRegistry()
      const stats = reg.getStats()
      if (stats.droppedTriples > 0) {
        // The registry is bounded (it lives on hub-main — D181). If it ever
        // truncates, the operator asking this question is told, because a
        // silently incomplete diagnostic is the defect this surface exists to
        // fix (D237).
        logger?.warn('cap-usage graph is truncated — the triple ceiling was reached', {
          meta: {
            triples: stats.triples,
            maxTriples: stats.maxTriples,
            droppedTriples: stats.droppedTriples,
          },
        })
      }
      return reg.getGraph({ windowSeconds: input.windowSeconds, nowMs: Date.now() })
    },
    setProcessLogLevel: async (input) => {
      // E2: for hub-local children, try the UDS path first (fire-and-forget);
      // fall back to the Moleculer $node-mgmt.setLogLevel action for remote
      // nodes (agents) that still run a per-node broker. The UDS path is always
      // attempted for hub/<runner> nodeIds even when the Moleculer path would
      // also work — both are safe to run in parallel during Phase E.
      const reachedViaUds = moleculer.setChildLogLevelByNodeId(input.nodeId, input.level)
      if (!reachedViaUds) {
        await broker.call(
          '$node-mgmt.setLogLevel',
          {
            level: input.level,
          },
          { nodeID: input.nodeId, timeout: 5_000 },
        )
      }
      return { success: true }
    },
    executeQuery: async (input) => {
      return await broker.call(
        `${input.addonId}.queryable.query`,
        { queryName: input.queryName, params: input.params ?? {} },
        { nodeID: input.nodeId, timeout: 30_000 },
      )
    },
  }
}

// ── integrations ────────────────────────────────────────────────────

interface IntegrationWithProcessState extends Integration {
  readonly processState: string
}

/**
 * The keychain handle a hub door uses for an integration's addon (D787), or
 * `null` when this registry predates the keychain (a test double, an older
 * kernel) — the door then stores the settings as it always did.
 */
function ownerSecrets(ar: AddonRegistryService, owner: string): SecretsAccess | null {
  return typeof ar.secretsForOwner === 'function' ? ar.secretsForOwner(owner) : null
}

/**
 * The integration settings keys the addon's own form stores in the keychain
 * (by schema type, D783) — so the admin read can withhold a plaintext under one
 * of them. Empty when the schema cannot be read (logged): markers are still
 * withheld, and a coerced marker is caught without a schema.
 */
async function integrationSecretKeys(
  ar: AddonRegistryService,
  addonId: string,
  logger: IScopedLogger,
): Promise<ReadonlySet<string>> {
  try {
    const provider = ar
      .getCapabilityRegistry()
      .getSingleton<IAddonSettingsProvider>('addon-settings')
    const schema = await provider?.getGlobalSettings({ addonId, nodeId: 'hub' })
    return collectKeychainStoredKeys(schema ?? null)
  } catch (err) {
    logger.warn(
      'integration settings: addon schema unreadable — plaintext secrets not detectable',
      {
        tags: { addonId },
        meta: { phase: 'getSettings', error: errMsg(err) },
      },
    )
    return new Set()
  }
}

function requireIntegrationRegistry(ar: AddonRegistryService): IIntegrationRegistry {
  const reg = ar.getIntegrationRegistry()
  if (!reg) throw new Error('IntegrationRegistry not available')
  return reg
}

function isDeviceProvider(value: unknown): value is IDeviceProvider {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'discoverDevices') === 'function'
  )
}

function getDeviceProvider(ar: AddonRegistryService, addonId: string): IDeviceProvider | null {
  const provider = ar.getCapabilityRegistry().getProviderByAddon('device-provider', addonId)
  return isDeviceProvider(provider) ? provider : null
}

// ── pre-creation connection test ────────────────────────────────────
//
// An integration's credentials must be answerable BEFORE the integration row
// exists — that is the whole point. Until 2026-08-09 this surface had a broker
// branch and then a DEFAULT branch that probed `settings.main_stream_url ??
// settings.url` with ffprobe, so every account integration (Dreo, Dreame, Tuya,
// Petkit, Wyze) was told `{"success":false,"error":"No stream URL provided"}`.
// The Test button had therefore NEVER worked for an account integration, and
// `integrations.create` had nothing to gate on: an operator who typed the wrong
// Dreo password got an integration anyway, which then failed silently at
// reconcile.
//
// The routing below is EXPLICIT and ordered — there is no default branch. The
// framework never guesses a test from the shape of the settings; a provider
// DECLARES its test by registering the `connection-test` cap. A stream-URL
// probe is one provider's implementation of that cap (see
// `addon-provider-rtsp`), not the universal fallback. An addon that declares
// nothing is a KNOWN `unsupported`, never a silent pass.

/** What a pre-creation test concluded, and who concluded it. */
interface ConnectionTestVerdict {
  readonly status: IntegrationTestConnectionStatus
  readonly error?: string
  readonly latencyMs?: number
  readonly detail?: string
  /** Addon id whose declared test answered — null when none did. */
  readonly testedBy: string | null
}

function isConnectionTestProvider(value: unknown): value is IConnectionTestProvider {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'testSettings') === 'function'
  )
}

function getConnectionTestProvider(
  ar: AddonRegistryService,
  addonId: string,
): IConnectionTestProvider | null {
  const provider = ar.getCapabilityRegistry().getProviderByAddon('connection-test', addonId)
  return isConnectionTestProvider(provider) ? provider : null
}

function isBrokerProvider(value: unknown): value is IBrokerProvider {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof Reflect.get(value, 'testConnection') === 'function'
  )
}

/**
 * Does this addon declare a pre-creation test at all? Drives
 * `getAvailableTypes().canTest`, so the wizard can say "this one cannot be
 * tested" instead of offering a button that always answers the same nonsense.
 *
 * Broker-mode addons count: their connection identity is the broker, and the
 * broker cap owns a real `testConnection`.
 */
function declaresConnectionTest(ar: AddonRegistryService, addonId: string, mode: string): boolean {
  if (getConnectionTestProvider(ar, addonId) !== null) return true
  if (mode !== 'broker') return false
  return isBrokerProvider(ar.getCapabilityRegistry().getProviderByAddon('broker', addonId))
}

/**
 * Run the DECLARED pre-creation test for `(addonId, settings)`.
 *
 * Never throws: a test that blows up is `inconclusive`, which is emphatically
 * NOT `rejected`. A timeout must not read as a refusal — it would block a
 * perfectly good create on a flaky network, and the operator would have no way
 * to tell the two apart.
 */
async function runConnectionTest(
  ar: AddonRegistryService,
  addonId: string,
  settings: Record<string, unknown>,
  logger: IScopedLogger,
): Promise<ConnectionTestVerdict> {
  // 1. The provider's own declared test — the primary path.
  const tester = getConnectionTestProvider(ar, addonId)
  if (tester) {
    try {
      const outcome = await tester.testSettings({ settings })
      if (outcome.outcome === 'validated') {
        return {
          status: 'validated',
          testedBy: addonId,
          ...(outcome.latencyMs !== undefined ? { latencyMs: outcome.latencyMs } : {}),
          ...(outcome.detail !== undefined ? { detail: outcome.detail } : {}),
        }
      }
      if (outcome.outcome === 'rejected') {
        return { status: 'rejected', error: outcome.error, testedBy: addonId }
      }
      return { status: 'inconclusive', error: outcome.error, testedBy: addonId }
    } catch (err) {
      logger.warn('connection test could not run', {
        tags: { addonId },
        meta: { phase: 'test', error: errMsg(err) },
      })
      return {
        status: 'inconclusive',
        error: `Connection test could not run: ${errMsg(err)}`,
        testedBy: addonId,
      }
    }
  }

  // 2. Broker-backed integrations carry their connection identity as a
  //    `brokerId`; the broker already owns the real semantic check (HA opens a
  //    temporary WS handshake, MQTT pings the bridge). Reached because the
  //    settings NAME a broker, not because nothing else matched.
  const brokerId = settings['brokerId']
  if (typeof brokerId === 'string' && brokerId.length > 0) {
    const brokerProvider = ar
      .getCapabilityRegistry()
      .getProviderByAddonId<IBrokerProvider>('broker', addonId)
    if (!brokerProvider) {
      return {
        status: 'inconclusive',
        error: `Broker provider for addon '${addonId}' is not available`,
        testedBy: null,
      }
    }
    try {
      const result = await brokerProvider.testConnection({ id: brokerId })
      return result.ok
        ? { status: 'validated', latencyMs: result.latencyMs, testedBy: addonId }
        : { status: 'rejected', error: result.error, testedBy: addonId }
    } catch (err) {
      logger.warn('broker connection test could not run', {
        tags: { addonId },
        meta: { phase: 'test', brokerId, error: errMsg(err) },
      })
      return {
        status: 'inconclusive',
        error: `Broker test could not run: ${errMsg(err)}`,
        testedBy: addonId,
      }
    }
  }

  // 3. Nothing declared. Say so plainly — this must never render as a pass,
  //    and must never render as a failure we did not observe.
  return {
    status: 'unsupported',
    error:
      `Integration '${addonId}' declares no connection test, ` +
      `so these settings cannot be validated before it is created.`,
    testedBy: null,
  }
}

/**
 * Marker caps that flag an addon as a creatable integration type:
 *   - `device-provider` — classic providers (Reolink/ONVIF)
 *     that expose `createDevice` + `discoverDevices` via their
 *     device-provider cap.
 *   - `device-adoption` — integration-style providers (Home Assistant
 *     and future siblings) that materialise devices via a generic
 *     adoption cap instead of a manual create-form. The picker treats
 *     them the same way; the wizard's discovery step routes through the
 *     specific cap based on the addon's declared surface.
 *
 * Exported so the integration-markers spec can assert the recognised set
 * without booting the whole provider factory.
 */
export const INTEGRATION_CAP_MARKERS = new Set(['device-provider', 'device-adoption'])

export function buildIntegrationsProvider(
  ar: AddonRegistryService,
  eb: EventBusService,
  loggingService: LoggingService,
  capabilityRegistry: CapabilityRegistry | null,
): IIntegrationsProvider {
  const logger = loggingService.createLogger('integrations')
  const withProcessState = (i: Integration): IntegrationWithProcessState => ({
    ...i,
    processState:
      ar.listAddons().find((a) => a.manifest.id === i.addonId)?.process?.state ?? 'unknown',
  })

  return {
    list: async () => {
      const integrations = await requireIntegrationRegistry(ar).listIntegrations()
      return integrations.map(withProcessState)
    },
    get: async (input) => {
      const integration = await requireIntegrationRegistry(ar).getIntegration(input.id)
      if (!integration) throw new Error(`Integration "${input.id}" not found`)
      return withProcessState(integration)
    },
    getByAddonId: async (input) =>
      requireIntegrationRegistry(ar).getIntegrationByAddonId(input.addonId),
    create: async (input) => {
      const { skipRestart, secretKeys, settings, ...rest } = input
      // Settings are written AFTER the row exists: a secret's ref is scoped
      // to the integration id (D787).
      const payload = rest
      const reg = requireIntegrationRegistry(ar)

      logger.info('request', {
        tags: { addonId: input.addonId },
        meta: { phase: 'create', name: input.name },
      })

      const addon = ar.listAddons().find((a) => a.manifest.id === input.addonId)
      const instanceMode =
        addon?.declaration?.instanceMode ?? addon?.manifest?.instanceMode ?? 'multiple'
      if (instanceMode === 'unique') {
        const existing = (await reg.listIntegrations()).filter((i) => i.addonId === input.addonId)
        if (existing.length > 0) {
          logger.warn('rejected duplicate unique', {
            tags: { addonId: input.addonId, integrationId: existing[0]!.id },
            meta: { phase: 'create' },
          })
          throw new TRPCError({
            code: 'CONFLICT',
            message: `Addon "${input.addonId}" is unique-instance and already has an integration (${existing[0]!.id})`,
          })
        }
      }

      // ── the gate ────────────────────────────────────────────────────
      //
      // "Next" must validate and create ONLY on success. `rejected` is the one
      // status that blocks: it means the remote was asked and said no. An
      // `unsupported` (no test declared) or `inconclusive` (declared test could
      // not complete) observed NOTHING about the credentials — refusing on
      // those would make every integration lacking the hook uncreatable, and
      // would fail a good create on a flaky network. They pass, and they SAY SO
      // in the log: silence here would read as "validated".
      const verdict = await runConnectionTest(ar, input.addonId, settings ?? {}, logger)
      if (verdict.status === 'rejected') {
        logger.warn('rejected — connection test refused the settings', {
          tags: { addonId: input.addonId },
          meta: { phase: 'create', status: verdict.status, testedBy: verdict.testedBy },
        })
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: verdict.error ?? `Connection test failed for '${input.addonId}'`,
        })
      }
      if (verdict.status === 'validated') {
        logger.info('connection test validated — proceeding', {
          tags: { addonId: input.addonId },
          meta: { phase: 'create', latencyMs: verdict.latencyMs },
        })
      } else {
        logger.warn('creating without validation — the settings were not validated', {
          tags: { addonId: input.addonId },
          meta: { phase: 'create', status: verdict.status, reason: verdict.error },
        })
      }

      const integration = await reg.createIntegration(payload)
      if (settings !== undefined && Object.keys(settings).length > 0) {
        await writeIntegrationSettings(
          {
            registry: reg,
            secrets: ownerSecrets(ar, integration.addonId),
            onOrphaned: (refs) =>
              logger.warn('dropped keychain refs could not be deleted', {
                meta: { refs: [...refs] },
              }),
          },
          {
            integrationId: integration.id,
            settings,
            secretKeys: secretKeys ?? [],
            operatorWrite: true,
          },
        )
      }
      logger.info('persisted', {
        tags: { integrationId: integration.id, addonId: integration.addonId },
        meta: { phase: 'create' },
      })

      const hasSettings = settings != null && Object.keys(settings).length > 0
      if (!skipRestart && hasSettings) {
        logger.info('settings present — restarting addon', {
          tags: { addonId: input.addonId },
          meta: { phase: 'create' },
        })
        await ar.restartAddon(input.addonId)
        logger.info('addon restart complete', {
          tags: { addonId: input.addonId },
          meta: { phase: 'create' },
        })
      } else {
        logger.info('skipping restart (no settings or skipRestart=true)', {
          meta: { phase: 'create' },
        })
      }
      return integration
    },
    update: async (input) => {
      const reg = requireIntegrationRegistry(ar)
      const previous = await reg.getIntegration(input.id)
      if (!previous) {
        logger.warn('not found', { tags: { integrationId: input.id }, meta: { phase: 'update' } })
        throw new Error(`Integration "${input.id}" not found`)
      }
      const { id, ...updates } = input
      const changedFields = Object.keys(updates).filter(
        (k) => (updates as Record<string, unknown>)[k] !== undefined,
      )
      logger.info('request', {
        tags: { integrationId: input.id, addonId: previous.addonId },
        meta: { phase: 'update', fields: changedFields },
      })

      const result = await reg.updateIntegration(id, updates)
      if (!result) throw new Error(`Integration "${id}" not found`)

      const enabledChanged = input.enabled !== undefined && input.enabled !== previous.enabled
      if (enabledChanged) {
        const category = input.enabled ? 'integration.enabled' : 'integration.disabled'
        logger.info('enabled state changed', {
          tags: { integrationId: result.id, addonId: result.addonId },
          meta: { phase: 'update', enabled: input.enabled },
        })
        eb.emit({
          id: `integration-${category}-${Date.now()}`,
          timestamp: new Date(),
          source: { type: 'integration', id: result.id },
          category,
          data: {
            integrationId: result.id,
            addonId: result.addonId,
          },
        })
      }

      if (input.name !== undefined && input.name !== previous.name) {
        logger.info('renamed', {
          tags: { integrationId: result.id },
          meta: { phase: 'update', previousName: previous.name, newName: input.name },
        })
      }

      const infoChanged = input.info !== undefined
      if (infoChanged) {
        logger.info('info changed — restarting addon', {
          tags: { addonId: result.addonId },
          meta: { phase: 'update' },
        })
        await ar.restartAddon(result.addonId)
        logger.info('addon restart complete', {
          tags: { addonId: result.addonId },
          meta: { phase: 'update' },
        })
      } else {
        logger.info('no restart needed (only enabled/name changed)', { meta: { phase: 'update' } })
      }
      return result
    },
    delete: async (input) => {
      const reg = requireIntegrationRegistry(ar)
      logger.info('request', { tags: { integrationId: input.id }, meta: { phase: 'delete' } })

      const integration = await reg.getIntegration(input.id)
      if (!integration) {
        logger.warn('not found', { tags: { integrationId: input.id }, meta: { phase: 'delete' } })
        throw new Error(`Integration "${input.id}" not found`)
      }
      // REFUSE BEFORE MUTATING ANYTHING.
      //
      // The registry enforces this too, but it is the LAST step here — and the
      // device cascade below is deliberately best-effort, so a refusal that
      // arrives afterwards has already destroyed every device the integration
      // owned. That is not theoretical: it deleted the Notification Center's
      // alarm panel (835) one second before the registry answered "is fixed",
      // and the panel came back with a new id and no state, silently breaking
      // every rule that named it.
      if (IntegrationRegistry.isFixed(integration)) {
        throw new Error(
          `integration "${input.id}" is fixed — it belongs to the addon that declared it and cannot be deleted`,
        )
      }

      logger.info('removing', {
        tags: { integrationId: input.id, addonId: integration.addonId },
        meta: { phase: 'delete', name: integration.name },
      })

      // Cascade-delete every live device whose integrationId matches.
      // Best-effort: a device-removal hiccup must not abort the integration
      // delete — log a warning and continue so the record + event always fire.
      const dm =
        capabilityRegistry?.getSingleton<{
          removeByIntegration?: (input: { integrationId: string }) => Promise<{ removed: number }>
          listAll?: (input: Record<string, never>) => Promise<
            readonly {
              id: number
              addonId: string
              parentDeviceId: number | null
              integrationId?: string
            }[]
          >
          setIntegrationId?: (input: { deviceId: number; integrationId: string }) => Promise<void>
        }>('device-manager') ?? null

      // Claim legacy un-tagged devices BEFORE the cascade. Devices created
      // before stamping (or whose provider never stamps, e.g. `provider-rtsp`)
      // carry no integrationId, so `removeByIntegration` (which matches on
      // integrationId) would leave them orphaned forever once their integration
      // is gone. While the integration record still exists, stamp the
      // unambiguous ones (addons hosting exactly one integration) so the cascade
      // below removes them too. Best-effort: never abort the delete.
      if (dm?.listAll && dm?.setIntegrationId) {
        try {
          const [integrations, devices] = await Promise.all([
            reg.listIntegrations(),
            dm.listAll({}),
          ])
          const stamps = planDeleteTimeStamps(
            input.id,
            integrations.map((i) => ({ id: i.id, addonId: i.addonId })),
            devices.map((d) => ({
              id: d.id,
              addonId: d.addonId,
              parentDeviceId: d.parentDeviceId,
              ...(d.integrationId !== undefined ? { integrationId: d.integrationId } : {}),
            })),
          )
          for (const stamp of stamps) {
            await dm.setIntegrationId({
              deviceId: stamp.deviceId,
              integrationId: stamp.integrationId,
            })
          }
          if (stamps.length > 0) {
            logger.info('claimed legacy un-tagged devices for cascade', {
              tags: { integrationId: input.id, addonId: integration.addonId },
              meta: { phase: 'delete', claimed: stamps.length },
            })
          }
        } catch (err) {
          logger.warn('legacy device claim failed (best-effort — continuing)', {
            tags: { integrationId: input.id },
            meta: { phase: 'delete', error: errMsg(err) },
          })
        }
      }

      if (dm?.removeByIntegration) {
        try {
          const result = await dm.removeByIntegration({ integrationId: input.id })
          logger.info('cascade-removed devices', {
            tags: { integrationId: input.id },
            meta: { phase: 'delete', removed: result.removed },
          })
        } catch (err) {
          logger.warn('device cascade-remove failed (best-effort — continuing)', {
            tags: { integrationId: input.id },
            meta: { phase: 'delete', error: errMsg(err) },
          })
        }
      } else {
        logger.warn('device-manager not available — skipping cascade device removal', {
          tags: { integrationId: input.id },
          meta: { phase: 'delete' },
        })
      }

      await reg.deleteIntegration(input.id)

      eb.emit({
        id: `integration-deleted-${Date.now()}`,
        timestamp: new Date(),
        source: { type: 'integration', id: input.id },
        category: EventCategory.IntegrationDeleted,
        data: {
          integrationId: input.id,
          addonId: integration.addonId,
        },
      })
      logger.info('completed (no restart)', {
        tags: { integrationId: input.id },
        meta: { phase: 'delete' },
      })

      return { success: true, deletedId: input.id }
    },
    getSettings: async (input) => {
      const reg = requireIntegrationRegistry(ar)
      const integration = await reg.getIntegration(input.id)
      if (!integration) throw new Error(`Integration "${input.id}" not found`)
      // The integration's own addon (the caller the transport stamped) reads
      // its secrets resolved; anyone else — the admin form — reads "set"
      // views, never a value (D787, D789).
      const caller: unknown = Reflect.get(input, 'callerAddonId')
      const forOwner =
        typeof caller === 'string' &&
        (caller === integration.addonId || ar.runnerIdFor(integration.addonId) === caller)
      // The schema is asked only for the admin read: the owner reads this at
      // its own boot, and asking it for its schema then would call back into it.
      const secretKeys = forOwner
        ? undefined
        : await integrationSecretKeys(ar, integration.addonId, logger)
      return readIntegrationSettings(
        { registry: reg, secrets: forOwner ? ownerSecrets(ar, integration.addonId) : null },
        {
          integrationId: input.id,
          forOwner,
          ...(secretKeys !== undefined ? { secretKeys } : {}),
          onSuspectSecret: (suspect) =>
            logger.error(
              suspect.kind === 'coerced-marker'
                ? 'integration secret is "[object Object]" — a keychain marker was coerced to text; the addon is sending it as the credential; re-type it'
                : 'integration secret stored as PLAINTEXT under a keychain-declared key — withheld from the form; re-type it to move it into the keychain',
              {
                tags: { integrationId: input.id, addonId: integration.addonId },
                meta: { phase: 'getSettings', key: suspect.key, kind: suspect.kind, forOwner },
              },
            ),
        },
      )
    },
    setSettings: async (input) => {
      const reg = requireIntegrationRegistry(ar)
      const integration = await reg.getIntegration(input.id)
      if (!integration) {
        logger.warn('not found', {
          tags: { integrationId: input.id },
          meta: { phase: 'setSettings' },
        })
        throw new Error(`Integration "${input.id}" not found`)
      }
      const settingsKeys = Object.keys(input.settings)
      logger.info('request', {
        tags: { integrationId: input.id, addonId: integration.addonId },
        meta: { phase: 'setSettings', keys: settingsKeys },
      })
      await writeIntegrationSettings(
        {
          registry: reg,
          secrets: ownerSecrets(ar, integration.addonId),
          onOrphaned: (refs) =>
            logger.warn('dropped keychain refs could not be deleted', {
              meta: { refs: [...refs] },
            }),
        },
        {
          integrationId: input.id,
          settings: input.settings,
          secretKeys: input.secretKeys ?? [],
          // The integration's own addon writing back is not the operator.
          operatorWrite: typeof Reflect.get(input, 'callerAddonId') !== 'string',
        },
      )

      // Only the integration's own addon may skip the respawn: it reconciles
      // the change in-process, so an unrelated caller cannot leave an addon
      // running on settings it never reloaded.
      const callerAddon: unknown = Reflect.get(input, 'callerAddonId')
      if (
        input.skipRestart === true &&
        typeof callerAddon === 'string' &&
        (callerAddon === integration.addonId || ar.runnerIdFor(integration.addonId) === callerAddon)
      ) {
        logger.info('persisted — the owner applies it in-process, no restart', {
          tags: { addonId: integration.addonId },
          meta: { phase: 'setSettings' },
        })
        return { success: true }
      }
      logger.info('persisted — restarting addon', {
        tags: { addonId: integration.addonId },
        meta: { phase: 'setSettings' },
      })
      await ar.restartAddon(integration.addonId)
      logger.info('addon restart complete', {
        tags: { addonId: integration.addonId },
        meta: { phase: 'setSettings' },
      })
      return { success: true }
    },
    getAvailableTypes: async () => {
      const reg = requireIntegrationRegistry(ar)
      const addons = ar.listAddons()
      // Hide failed-to-load packages from the picker. Fix #7 surfaces them in
      // the Addons page so the operator can uninstall, but creating an
      // integration against an addon that didn't load produces an orphaned
      // row that `createFilteredRegistry` then filters out — silent data
      // loss from the operator's POV. Filter at the source instead.
      //
      // Markers that flag an addon as a creatable integration type live
      // in the module-level `INTEGRATION_CAP_MARKERS` set (exported so the
      // integration-markers spec can assert the recognised caps).
      const providerAddons = addons.filter(
        (a) =>
          a.process?.state !== 'failed' &&
          a.manifest.capabilities?.some((c) => {
            const name = typeof c === 'string' ? c : c.name
            return typeof name === 'string' && INTEGRATION_CAP_MARKERS.has(name)
          }),
      )
      const integrations = await reg.listIntegrations()
      return providerAddons.map((addon) => {
        const m = addon.manifest
        const d = addon.declaration
        const icon = d?.icon ?? m.icon
        const color = d?.color ?? m.color ?? '#78716c'
        const instanceMode = d?.instanceMode ?? m.instanceMode ?? 'multiple'
        const existing = integrations.filter((i) => i.addonId === m.id)
        const provider = getDeviceProvider(ar, m.id)
        const discoveryMode = provider?.discoveryMode ?? 'manual'

        // Branch by CAP, not by addon name. Surface which integration-marker
        // cap the addon declared so the wizard routes `device-adoption`
        // (Approach A: pick/create a broker, store `{ brokerId }`) vs the
        // legacy `device-provider` config → discovery flow. A `device-adoption`
        // marker wins when both are present (an integration-style addon may
        // also expose a `device-provider` shim); the broker step is the
        // intended entry point for it.
        const capNames = (m.capabilities ?? []).map((c) => (typeof c === 'string' ? c : c.name))
        const kind: 'device-adoption' | 'device-provider' = capNames.includes('device-adoption')
          ? 'device-adoption'
          : 'device-provider'

        // For device-adoption addons, the broker kind to create/link comes
        // from the addon manifest (`brokerKind`). Null for device-provider
        // addons, which carry no broker.
        const brokerKind =
          kind === 'device-adoption' ? (d?.brokerKind ?? m.brokerKind ?? null) : null

        const supportsLocationImport =
          kind === 'device-adoption'
            ? (d?.supportsLocationImport ?? m.supportsLocationImport ?? false)
            : false

        // Integration wizard `mode` (LOCKED MODEL — supersedes `instanceMode`
        // for wizard routing). Explicit manifest `mode` wins; otherwise derive:
        //   1. broker cap AND a brokerKind → 'broker' (HA/MQTT shared session)
        //   2. device-adoption (and NOT broker) → 'account'
        //   3. device-provider only / old `instanceMode: unique` → 'standalone'
        const explicitMode = d?.mode ?? m.mode
        const declaresBroker = capNames.includes('broker')
        const mode: 'standalone' | 'account' | 'broker' =
          explicitMode ??
          (declaresBroker && brokerKind
            ? 'broker'
            : kind === 'device-adoption'
              ? 'account'
              : 'standalone')

        return {
          addonId: m.id,
          name: m.name ?? m.id,
          description: m.description ?? '',
          iconUrl: icon ? `/api/addon-assets/${m.id}/${icon}` : null,
          color,
          instanceMode,
          mode,
          discoveryMode,
          kind,
          brokerKind,
          supportsLocationImport,
          canTest: declaresConnectionTest(ar, m.id, mode),
          existingInstances: existing.map((i) => ({
            id: i.id,
            name: i.name,
          })),
          canAdd: instanceMode === 'multiple' || existing.length === 0,
        }
      })
    },
    testConnection: async (input) => {
      // The Test button. Routes to the DECLARED test (see `runConnectionTest`)
      // and reports the tri-state verbatim: `success` is true ONLY for
      // `validated`, so a test that never ran can never render as a tick — and
      // `status` lets the UI show "could not be validated" in its own colour
      // instead of a red failure nobody observed.
      const verdict = await runConnectionTest(ar, input.addonId, input.settings, logger)
      logger.info('connection test', {
        tags: { addonId: input.addonId },
        meta: { phase: 'test', status: verdict.status, testedBy: verdict.testedBy },
      })
      return {
        success: verdict.status === 'validated',
        status: verdict.status,
        testedBy: verdict.testedBy,
        ...(verdict.error !== undefined ? { error: verdict.error } : {}),
        ...(verdict.latencyMs !== undefined ? { latencyMs: verdict.latencyMs } : {}),
        ...(verdict.detail !== undefined ? { detail: verdict.detail } : {}),
      }
    },
  }
}

// ── addons ──────────────────────────────────────────────────────────
//
// `addons.custom` enforces per-action auth dynamically. The cap-router
// codegen passes ctx into `getProvider(ctx)` so we can close over
// `ctx.user` and reject before dispatching.

function ensureCustomActionAuth(ctx: TrpcContext, level: CapabilityMethodAuth): void {
  if (level === 'public') return
  if (!ctx.user) {
    throw new TRPCError({ code: 'UNAUTHORIZED' })
  }
  if (level === 'protected') return
  if (level === 'admin') {
    if (!ctx.user.isAdmin) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'custom action requires admin' })
    }
    return
  }
}

/** Input shape for the `addons.custom` dispatcher (mirrors `CustomActionInputSchema`). */
export interface CustomActionDispatchInput {
  readonly addonId: string
  readonly action: string
  readonly input: unknown
}

/** How many neighbouring names a NOT_FOUND message is willing to spell out. */
const UNRESOLVED_HINT_LIMIT = 40

/**
 * Explain a `(addonId, action)` that did not resolve, by NAMING what does.
 *
 * `addons.custom` keys on the MANIFEST addon id (`camstack.addons[].id`), which
 * is routinely not the npm package name — `@camstack/addon-post-analysis` ships
 * `pipeline-analytics` and `embedding-encoder`, and neither is the package. A
 * bare "has no custom action X" is then indistinguishable from "the addon is
 * broken", "the deploy did not land" or "the catalog never registered", and the
 * caller has no way to tell which. That ambiguity cost a session on 2026-08-08:
 * a working require-cache fix (d0bf802f1) was investigated as the culprit while
 * the action was reachable the whole time under its real id.
 *
 * So the two failures are separated and each names its neighbourhood — the ids
 * that have actions, or the actions that addon has.
 */
function describeUnresolved(
  registry: CustomActionRegistry,
  input: CustomActionDispatchInput,
): string {
  const actions = registry.listActions(input.addonId)
  if (actions.length > 0) {
    return `addon '${input.addonId}' has no custom action '${input.action}' — known actions: ${formatNames(actions)}`
  }
  return (
    `no addon '${input.addonId}' registers custom actions ` +
    `(expected a manifest addon id, not the npm package name) — ` +
    `addons with custom actions: ${formatNames(registry.listAddons())}`
  )
}

/** Sorted, comma-joined, bounded — a hint must never become a dump. */
function formatNames(names: readonly string[]): string {
  if (names.length === 0) return '(none)'
  const sorted = [...names].sort()
  const shown = sorted.slice(0, UNRESOLVED_HINT_LIMIT)
  const rest = sorted.length - shown.length
  return rest > 0 ? `${shown.join(', ')} (+${rest} more)` : shown.join(', ')
}

/**
 * Resolve + dispatch a single addon custom action. This is the LIVE dispatch
 * used by the `addons.custom` cap-provider handler below — factored out so it
 * can be unit-tested directly against the real code path.
 *
 * Responsibilities (in order):
 *   1. Resolve `(addonId, action)` against the process `CustomActionRegistry`.
 *   2. Enforce the action's declared per-action auth (`ensureCustomActionAuth`).
 *      NOTE: the OUTER cap mount is `protected`, so unauthenticated callers are
 *      already rejected before this runs; the generic cap-router auth matrix
 *      covers that mount-level gate.
 *   3. Validate input against the action's Zod schema.
 *   4. Forward the authenticated caller only when the action opts in with
 *      `caller: 'required'` (derived server-side from the principal, never
 *      trusted from input).
 *   5. Validate the addon's output — crash-early on a misbehaving addon.
 */
export async function dispatchCustomAction(
  registry: CustomActionRegistry,
  ctx: TrpcContext,
  input: CustomActionDispatchInput,
): Promise<unknown> {
  const entry = registry.resolve(input.addonId, input.action)
  if (!entry) {
    throw new TRPCError({ code: 'NOT_FOUND', message: describeUnresolved(registry, input) })
  }
  ensureCustomActionAuth(ctx, entry.spec.auth)
  const parsedInput = entry.spec.input.parse(input.input)
  const caller =
    entry.spec.caller === 'required' && ctx.user
      ? { userId: ctx.user.id, isAdmin: ctx.user.isAdmin }
      : undefined
  const result = await entry.handler(parsedInput, caller)
  return entry.spec.output.parse(result)
}

/** A node id that refers to the hub itself (top-level or a hub group runner). */
function isHubNode(nodeId: string): boolean {
  return nodeId === 'hub' || nodeId.startsWith('hub/')
}

/**
 * Read an agent's installed npm packages via `$agent.status`. The
 * agent reports its addon roster (id + status + version + packageName);
 * we keep only entries that carry both a package name and a version so
 * the hub can diff them against npm.
 *
 * `@camstack/system` is KEPT, and it is one of the most important entries here.
 * On an agent, `addons/@camstack/system` is the only copy of the builtin infra
 * ([D87](../../../../docs/decisions/adr-0087.md)), so a pending update on it is
 * a true, actionable signal: the node's infra is behind the closure it runs
 * against. Both agents sat 17 versions behind that way until 2026-08-11. Do not
 * filter it out to make the list look clean — the number reaching zero is the
 * point of the number.
 */
/**
 * How long the hub waits for an agent's `$agent.undeploy`. It stops runners
 * (each up to a 5 s SIGTERM grace plus the group reap) and may respawn a shared
 * runner's survivors, so it is far longer than a status read.
 */
const AGENT_UNDEPLOY_TIMEOUT_MS = 120_000

function parseAgentStatusAddons(reply: unknown): readonly AgentStatusAddonRow[] {
  if (typeof reply !== 'object' || reply === null || !('addons' in reply)) return []
  const addons: unknown = reply.addons
  if (!Array.isArray(addons)) return []
  const rows: AgentStatusAddonRow[] = []
  for (const raw of addons) {
    if (typeof raw !== 'object' || raw === null || !('id' in raw) || typeof raw.id !== 'string') {
      continue
    }
    const packageName =
      'packageName' in raw && typeof raw.packageName === 'string' ? raw.packageName : undefined
    const version = 'version' in raw && typeof raw.version === 'string' ? raw.version : undefined
    rows.push({ id: raw.id, packageName, version })
  }
  return rows
}

/**
 * The real seam behind `addons.uninstallPackage` / `listInstallations`. The
 * agent leg is the same hub-side `broker.call({ nodeID })` to the agent's
 * `$agent` service that `updatePackage({ nodeId })` uses.
 */
function buildUninstallSeam(
  ar: AddonRegistryService,
  ps: AddonPackageService,
  broker: BrokerLike,
  agentRegistry: AgentRegistryService | undefined,
): AddonUninstallSeam {
  return {
    isProtected: (name) => ps.isProtected(name),
    listHubPackages: () => {
      let installed: readonly { name: string; version: string }[]
      try {
        installed = ps.listInstalled()
      } catch {
        return []
      }
      const idsByPackage = new Map<string, string[]>()
      for (const row of ar.listAddons()) {
        const ids = idsByPackage.get(row.manifest.packageName) ?? []
        ids.push(row.manifest.id)
        idsByPackage.set(row.manifest.packageName, ids)
      }
      return installed.map((p) => ({
        name: p.name,
        version: p.version,
        addonIds: idsByPackage.get(p.name) ?? [],
      }))
    },
    uninstallOnHub: async (name) => {
      await ps.uninstallAndReload(name)
    },
    listAgents: async () => {
      if (!agentRegistry) return []
      const directory = await agentRegistry.listNodeDirectory()
      return directory.nodes
        .filter((n) => !n.isHub && !n.id.includes('/'))
        .map((n) => ({ id: n.id, name: n.name, isOnline: n.isOnline }))
    },
    agentAddons: async (nodeId) =>
      parseAgentStatusAddons(
        await broker.call(
          '$agent.status',
          {},
          { nodeID: nodeId, timeout: AGENT_STATUS_TIMEOUT_MS },
        ),
      ),
    agentUndeploy: (nodeId, request) =>
      broker.call('$agent.undeploy', request, {
        nodeID: nodeId,
        timeout: AGENT_UNDEPLOY_TIMEOUT_MS,
      }),
    recordedPackages: async (nodeId) =>
      agentRegistry ? agentRegistry.getRecordedPackages(nodeId) : [],
    notePackageUndeployed: async (nodeId, packageName, addonIds) => {
      await agentRegistry?.notePackageUndeployed(nodeId, packageName, addonIds)
    },
  }
}

export function buildAddonsProvider(
  ar: AddonRegistryService,
  ps: AddonPackageService,
  ls: LoggingService,
  moleculer: MoleculerService,
  configService: ConfigService,
  ctx: TrpcContext,
  agentRegistry?: AgentRegistryService,
): IAddonsProvider {
  const broker = asBrokerLike(moleculer.broker)
  const uninstallSeam = buildUninstallSeam(ar, ps, broker, agentRegistry)

  const frameworkAllowSet = new Set<string>([SYSTEM_PACKAGE])

  // D982: a hub install / update / uninstall changes every node's desired set.
  // Fire-and-forget — the round never gates the operator's call, and bursts
  // collapse into one extra round inside `requestConvergence`.
  const requestHubChangeConvergence = (): void => {
    void agentRegistry?.requestConvergence('hub-change')
  }

  // Ship an already-packed tarball to one agent and reload it. The reload
  // re-instantiates the changed package's addons; for a large package (the whole
  // pipeline stack) that can take well over a minute, so allow generous headroom
  // — a timeout here aborts the call even though the deploy already landed.
  const deployPackedToAgent = async (
    agentNodeId: string,
    packageName: string,
    bundle: Buffer,
  ): Promise<void> => {
    await broker.call(
      '$agent.deploy',
      { addonId: packageName, bundle },
      { nodeID: agentNodeId, timeout: 300_000 },
    )
    await broker.call('$agent.reload', {}, { nodeID: agentNodeId, timeout: 300_000 })
  }

  // Process-wide runner built once at boot (manual-boot wires its deps from the
  // addon-package service + event bus). `createdBy` travels per `startJob` call.
  const lifecycleRunner = getLifecycleRunner()

  // Who triggered each lifecycle job from this request context.
  const lifecycleCreatedBy = ctx.user?.username ?? ctx.user?.id ?? 'system'

  return {
    list: async (input) => {
      const nodeId = input?.nodeId
      const rollbackable = ps.getRollbackablePackages()
      const healthByPackage = new Map<
        string,
        ReturnType<typeof ar.getAddonHealthSnapshot>[number]
      >()
      for (const h of ar.getAddonHealthSnapshot()) {
        healthByPackage.set(h.packageName, h)
      }
      // Real runner states (D877) - never the literal `running` the list used to carry.
      await ar.refreshRunnerStates()
      const hubList = ar.listAllAddons().map((item) => ({
        ...item,
        hasBackup: rollbackable.has(item.manifest.packageName),
        health: healthByPackage.get(item.manifest.packageName) ?? null,
      }))
      if (nodeId === undefined || isHubNode(nodeId)) {
        return hubList
      }
      // Agent: same roster source as listUpdates — stamp agent versions onto
      // hub manifests so cards show what that node actually runs.
      const agentPackages = await fetchAgentInstalledPackages(broker, nodeId)
      const versionByPackage = new Map<string, string>()
      for (const pkg of agentPackages) {
        versionByPackage.set(pkg.name, pkg.version)
      }
      return hubList.flatMap((item) => {
        const agentVersion = versionByPackage.get(item.manifest.packageName)
        if (agentVersion === undefined) return []
        return [
          {
            ...item,
            manifest: {
              ...item.manifest,
              packageVersion: agentVersion,
              ...(typeof item.manifest.version === 'string' ? { version: agentVersion } : {}),
            },
            hasBackup: false,
            health: null,
            // The hub's runner state is not this agent's: report none rather than a borrowed one.
            process: undefined,
          },
        ]
      })
    },
    getLogs: async (input) =>
      ls.query({
        tags: { addonId: input.addonId },
        limit: input.limit,
        level: input.level,
      }),
    listPackages: async () => ps.listInstalled(),
    installPackage: async (input) => {
      const result = await ps.installAndLoad(input.packageName, input.version)
      requestHubChangeConvergence()
      return result
    },
    installFromWorkspace: async (input) => {
      const result = await ps.installFromWorkspaceAndLoad(input.packageName)
      requestHubChangeConvergence()
      return result
    },
    isWorkspaceAvailable: async () => ps.isWorkspaceAvailable(),
    listWorkspacePackages: async () => ps.listWorkspacePackages(),
    uninstallPackage: async (input) => {
      try {
        const result = await uninstallPackage(uninstallSeam, input)
        requestHubChangeConvergence()
        return result
      } catch (err) {
        if (err instanceof PackageProtectedError) {
          throw new TRPCError({ code: 'FORBIDDEN', message: err.message })
        }
        throw err
      }
    },
    listInstallations: async (input) => listInstallations(uninstallSeam, input.packageName),
    reloadPackages: async () => ps.reloadPackages(),
    searchAvailable: async (input) => {
      const results = await ps.searchNpm(input?.query, input?.capability)
      const installedIds = new Set(ps.listInstalled().map((p) => p.name))
      return results.map((r) => ({
        ...r,
        installed: installedIds.has(r.name),
      }))
    },
    listUpdates: async (input) => {
      const nodeId = input.nodeId
      const updates =
        nodeId === undefined || isHubNode(nodeId)
          ? await ps.checkUpdates()
          : await ps.checkUpdatesForInstalled(
              await fetchAgentInstalledPackages(broker, nodeId),
              nodeId,
            )
      return updates.map((u) => ({ ...u, isSystem: frameworkAllowSet.has(u.name) }))
    },
    updatePackage: async (input) => {
      const nodeId = input.nodeId
      if (isAgentTrackedPackage(input.name) && (nodeId === undefined || isHubNode(nodeId))) {
        // An agent-only package the hub tracks without loading it (agent-ui, D982):
        // there is nothing to update on the hub, so the update fans out to every
        // online agent instead of failing with "not currently tracked in manifest".
        if (agentRegistry === undefined) {
          return {
            success: false,
            error: `${input.name} is delivered by the agent registry, which is not wired`,
          }
        }
        const packed = await ps.packPackage(input.name, input.version)
        const targets = agentRegistry.onlineAgentIds()
        const failures: string[] = []
        for (const target of targets) {
          try {
            await deployPackedToAgent(target, input.name, packed.buffer)
            await agentRegistry.noteExplicitDelivery(target, input.name)
          } catch (err) {
            failures.push(`${target}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (failures.length > 0) return { success: false, error: failures.join('; ') }
        return { success: true, name: input.name, version: packed.version }
      }
      if (nodeId === undefined || isHubNode(nodeId)) {
        // Hub-single: route through the lifecycle job engine so the fast
        // staged-swap path (applyStagedAddonUpdate) is always used.
        const version = input.version ?? 'latest'
        const { jobId } = await lifecycleRunner.startJob({
          kind: 'update',
          targets: [{ name: input.name, version }],
          createdBy: lifecycleCreatedBy,
        })
        const job = lifecycleRunner.getJob(jobId)
        const task = job?.tasks[0]
        if (task?.phase === 'done') {
          requestHubChangeConvergence()
          return { success: true, name: input.name, version, jobId }
        }
        return { success: false, error: task?.error ?? 'update failed', jobId }
      }
      // `@camstack/system` DELIBERATELY travels this way to an agent, and it is
      // the only way it can. On the hub, `addons/@camstack/system` is a shadow
      // of the closure; on an AGENT it is THE ONLY COPY of the builtin infra —
      // `bootCoreAddons` scans the addon root and nothing else, and the image
      // seed excludes the framework set on purpose ([D87](../../../../docs/decisions/adr-0087.md)).
      // Removing it on 2026-08-07 left the node with no `filesystem-storage`,
      // `sqlite-settings`, `storage-orchestrator`, `hub-forwarder`,
      // `metrics-native` or `platform-probe`, and the outage was unobservable
      // because the log shipper was in the same package.
      //
      // So do NOT add a framework guard here. A 2026-08-11 attempt to do so read
      // the launcher's `resolved @camstack/system@… from <activeRoot>` line as
      // proof that nothing loads the addon-root copy. That line answers which
      // copy the LAUNCHER resolves for its own imports — a different consumer
      // from `bootCoreAddons`. Same trap D45 names: a version is a property of a
      // path, and a path is only evidence about the consumer that reads it.
      // Agent target: the hub packs the resolved version and ships the
      // tarball over `$agent.deploy` — the agent has no npm runtime.
      // The reload re-instantiates the changed package's addons; for a large
      // package (e.g. the whole pipeline stack) that can take well over a
      // minute, so allow generous headroom — a timeout here aborts the call
      // even though the deploy already landed on disk.
      const packed = await ps.packPackage(input.name, input.version)
      await deployPackedToAgent(nodeId, input.name, packed.buffer)
      // An operator's explicit delivery lifts the node's tombstone (D982).
      await agentRegistry?.noteExplicitDelivery(nodeId, input.name)
      return { success: true, name: input.name, version: packed.version, nodeId }
    },
    rollbackPackage: async (input) => ps.rollbackPackage(input.name),
    forceRefresh: async (input) => {
      const nodeId = input.nodeId
      if (nodeId === undefined || isHubNode(nodeId)) return ps.checkUpdates(true)
      // Agent rosters carry no hub-side cache — the diff is always live.
      const installed = await fetchAgentInstalledPackages(broker, nodeId)
      return ps.checkUpdatesForInstalled(installed, nodeId)
    },
    restartServer: async () => ps.restartServer(ctx.user?.username ?? ctx.user?.id),
    getLastRestart: async () => {
      // Avoid pulling PostBootService through the cap-providers tree —
      // dynamic import keeps the wiring loose and lets us read the
      // static cache without a constructor dependency.
      const mod = await import('../../boot/post-boot.service.js')
      return mod.PostBootService.getLastRestart()
    },
    listFrameworkPackages: async () => ps.listFrameworkPackages(),
    listCapabilityProviders: async (input) => {
      const registry = ar.getCapabilityRegistry()
      const caps = registry.listCapabilities()
      const found = caps.find((c) => c.name === input.capName)
      if (!found) return []
      const mode = found.mode === 'collection' ? ('collection' as const) : ('singleton' as const)
      const disabled = new Set(found.disabledProviders)
      return found.providers.map((addonId) => ({
        addonId,
        mode,
        isActive: mode === 'collection' ? !disabled.has(addonId) : found.activeProvider === addonId,
      }))
    },
    setCapabilityProviderEnabled: async (input) => {
      // Refused (unknown cap, not a collection, unregistered provider) before
      // anything is written; otherwise the new disabled-set is PERSISTED first
      // and applied live only once the write landed (D675 amendment).
      await writeCollectionToggle(configService, ar.getCapabilityRegistry(), {
        capability: input.capName,
        addonId: input.addonId,
        enabled: input.enabled,
      })
      return { success: true as const }
    },
    getVersions: async (input) => ps.getPackageVersions(input.name),
    getPackageDocs: async (input) => ps.getPackageDocs(input.name, input.version),
    restartAddon: async (input) => ar.restartAddon(input.addonId),
    retryLoad: async (input) => {
      await ar.retryAddonLoad(input.packageName)
      return { success: true as const }
    },
    getAutoUpdateSettings: async () => ps.getAutoUpdateSettings(),
    setAutoUpdateSettings: async (input) =>
      ps.setAutoUpdateSettings(
        input.channel,
        input.intervalSeconds,
        input.updateCheckIntervalSeconds,
      ),
    getAddonAutoUpdate: async (input) => ps.getAddonAutoUpdate(input.addonId),
    setAddonAutoUpdate: async (input) => ps.setAddonAutoUpdate(input.addonId, input.channel),
    applyAutoUpdateToAll: async (input) => {
      await ps.setAutoUpdateSettings(input.channel)
      for (const pkg of ps.listInstalled()) {
        await ps.setAddonAutoUpdate(pkg.name, input.channel)
      }
      return { success: true as const }
    },
    // ── Lifecycle job engine ─────────────────────────────────────────
    startJob: async (input) => {
      // The engine is HUB-LOCAL: `StartJobInput.nodeIds` is declared
      // "reserved for future cluster jobs" and nothing reads it. Passing an
      // agent id therefore used to apply every target to the HUB while the
      // job, its per-task `nodeId` and the UI all reported the agent — so
      // "Update all" on a selected agent silently updated the wrong node and
      // left the agent pending forever. That is how two agents sat at 8
      // pending addons across several sessions (2026-08-11). Refuse instead:
      // an agent converges one package at a time through `updatePackage`,
      // which has a real `$agent.deploy` path.
      const offNode = (input.nodeIds ?? []).filter((id) => !isHubNode(id))
      if (offNode.length > 0) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message:
            input.kind === 'uninstall'
              ? `The lifecycle job engine is hub-local; it cannot target ${offNode.join(', ')}. Uninstall from an agent via uninstallPackage({ packageName, nodeId }), or from every node via uninstallPackage({ packageName, everywhere: true }).`
              : `The lifecycle job engine is hub-local; it cannot target ${offNode.join(', ')}. Update an agent's packages via updatePackage({ nodeId }).`,
        })
      }
      return lifecycleRunner.startJob({
        kind: input.kind,
        targets: input.targets,
        nodeIds: input.nodeIds,
        createdBy: lifecycleCreatedBy,
      })
    },
    getJob: async (input) => lifecycleRunner.getJob(input.jobId),
    listJobs: async (input) => lifecycleRunner.listJobs({ activeOnly: input.activeOnly }),
    cancelJob: async (input) => lifecycleRunner.cancelJob(input.jobId),

    custom: async (input) => dispatchCustomAction(ar.getCustomActionRegistry(), ctx, input),
    onAddonLogs: (input, push) => {
      const unsubscribe = ls.subscribe(
        { tags: { addonId: input.addonId }, level: input.level },
        (entry: {
          timestamp: Date | string | number
          level: string
          message: string
          scope?: string
        }) => {
          push({
            timestamp:
              entry.timestamp instanceof Date
                ? entry.timestamp.toISOString()
                : String(entry.timestamp),
            level: entry.level,
            message: entry.message,
            scope: entry.scope,
          })
        },
      )
      return unsubscribe ?? (() => {})
    },
  }
}

// Avoid an unused-import warning in environments where NotificationService
// is referenced solely via type imports above.
export type _NotificationServiceHint = NotificationService
