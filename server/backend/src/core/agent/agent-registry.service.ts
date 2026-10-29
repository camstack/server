import { randomUUID } from 'node:crypto'
import * as os from 'node:os'
import {
  callWithServiceDiscovery,
  getProcessAgentHttpsNames,
  localSupportedPythonRuntimes,
} from '@camstack/system'
import type {
  AgentCapability,
  AgentListItem,
  CameraRoleAssignment,
  IMetricsProvider,
  IScopedLogger,
  NodeDirectory,
  NodeLiveness,
} from '@camstack/types'
import { type AddonPlacement, EventCategory, resolveAddonPlacement } from '@camstack/types'
import type { AddonRegistryService } from '../addon/addon-registry.service'
import { CapabilityService } from '../capability/capability.service'
import { EventBusService } from '../events/event-bus.service'
import { MoleculerService } from '../moleculer/moleculer.service'
import {
  BackfillAttemptTracker,
  type BackfillFailureRecord,
  type BackfillSeam,
  type BackfillTrigger,
  computeBackfillPlan,
  confirmBackfillPlan,
  executeBackfill,
  MAX_BACKFILL_ATTEMPTS,
  type NodePackageEntry,
  triggerMayDeliver,
} from './agent-addon-backfill'
import { AgentDeliveryLedger } from './agent-delivery-ledger'
import { agentOfflineData, nodeDisplayName } from './agent-liveness-event'
import { ClusterNodeHistoryMirror } from './cluster-node-history-mirror'
import type {
  ClusterNodeDescriptor,
  ClusterNodeHistoryStore,
  ForgetHistoryOutcome,
  PersistedClusterNode,
} from './cluster-node-history-store'
import { toNodeDirectory } from './node-directory'

/** What forgetting a node did to its mesh certificates. */
export type NodeCertificateRevocation =
  | { readonly outcome: 'not-attempted' }
  | { readonly outcome: 'revoked'; readonly serials: string[] }
  | { readonly outcome: 'registry-unavailable' }
  | { readonly outcome: 'failed'; readonly error: string }

/**
 * Revokes every certificate issued to `nodeId` and cuts its sockets. Resolves to the serials put
 * on the revocation list, or `null` when the certificate registry is not loaded.
 */
export type NodeCertificateRevoker = (
  nodeId: string,
  reason: string,
) => Promise<readonly string[] | null>

/** The reason recorded on a certificate revoked because its node was forgotten. */
export const FORGOTTEN_NODE_REVOCATION_REASON = 'forgotten'

function describeRevocation(revocation: NodeCertificateRevocation): string {
  switch (revocation.outcome) {
    case 'not-attempted':
      return ''
    case 'revoked':
      return ` ${revocation.serials.length} certificate(s) revoked - the node must be paired again.`
    case 'registry-unavailable':
      return ' Its certificates were NOT revoked (the certificate registry is not loaded) - it can still reconnect.'
    case 'failed':
      return ` Its certificates were NOT revoked (${revocation.error}) - it can still reconnect.`
  }
}

/**
 * What "Forget node" removed — the honest answer the operator's button needs.
 *
 * `forgotten` is the only field a caller may treat as "something changed", and
 * `stillListed` is the one that matters when it did not: it is read back from
 * Moleculer's catalog AFTER the removal, so a row that survives is reported as
 * surviving instead of being asserted away.
 */
export interface ForgetClusterNodeResult {
  /**
   * What happened to the node's mesh certificates (D857). A forgotten node whose leaf stays
   * valid walks back in on its next boot, so this is reported separately: `registry-unavailable`
   * and `failed` mean the certificates were NOT revoked (never "0 revoked", D393).
   */
  readonly certificates: NodeCertificateRevocation
  /** True when at least one source of the node's topology row was purged. */
  readonly forgotten: boolean
  /** The durable history row existed and is gone. */
  readonly historyRemoved: boolean
  /** The Moleculer node-catalog entry existed and is gone. */
  readonly registryRemoved: boolean
  /** The node is STILL in Moleculer's catalog after the attempt. */
  readonly stillListed: boolean
  /** One operator-grade sentence naming what happened. */
  readonly message: string
}

/** The slice of Moleculer's registry this service touches — one boundary type. */
interface NodeCatalogRegistryLike {
  readonly getNodeList?: (opts: { readonly onlyAvailable: boolean }) => readonly {
    readonly id: string
    readonly available?: boolean
    readonly hostname?: string | null
  }[]
  readonly nodes?: {
    readonly delete?: (id: string) => boolean
    /**
     * Moleculer's `NodeCatalog.disconnected`: marks an AVAILABLE node unavailable, unregisters its
     * services and rejects the requests still waiting on it. A no-op for a node already offline.
     */
    readonly disconnected?: (id: string, isUnexpected: boolean) => void
  }
}

/** Turn a forget outcome into the sentence the operator reads. */
function describeForgetOutcome(
  nodeId: string,
  history: ForgetHistoryOutcome,
  registryRemoved: boolean,
  stillListed: boolean,
): string {
  const parts: string[] = []
  if (history === 'removed') parts.push('history row removed')
  else if (history === 'not-found') parts.push('no history row to remove')
  else if (history === 'store-unavailable')
    parts.push('history store unavailable — row fate unknown')
  else parts.push('history removal failed')
  parts.push(registryRemoved ? 'cluster registry entry removed' : 'no cluster registry entry')
  if (stillListed) {
    return `${nodeId}: ${parts.join('; ')} — but the node is STILL in the cluster registry and will keep appearing.`
  }
  return `${nodeId}: ${parts.join('; ')}.`
}

/** Per-call timeout for `$agent.*` RPC during reconciliation. */
const AGENT_RECONCILE_RPC_TIMEOUT_MS = 8_000

/**
 * Timeout for a back-fill `$agent.deploy` / `$agent.reload`. Generous on
 * purpose: the agent pulls the tarball over HTTP, runs its installer
 * (`installFromTgz` → runtime-dep `npm install` → native prebuilds) and
 * re-instantiates the package's addons. For the pipeline stack that is minutes,
 * and a timeout here aborts the call even though the deploy already landed.
 * Matches the `addons.updatePackage` agent path.
 */
export const AGENT_BACKFILL_RPC_TIMEOUT_MS = 300_000

/**
 * Package name of the system/infrastructure builtins. Addons shipped in
 * `@camstack/system` (filesystem-storage, storage-orchestrator,
 * sqlite-settings, hub-forwarder, metrics-native, console-logging, …) are
 * bootstrap infrastructure that EVERY node — hub and agent alike — runs
 * in-process. They are never `$agent.deploy`-pushed and must NEVER be
 * undeployed by reconciliation: tearing them down on an agent destroys its
 * own storage/settings/metrics/logging and bricks the node. This is the
 * same canonical "core builtin" predicate the hub uses in
 * `AddonRegistryService.buildAddonGroupPlan`.
 */
/**
 * Agent bootstrap-infrastructure packages — seeded by the agent's own
 * `AGENT_PACKAGES` bootstrap, NEVER hub-managed deploy targets, so the
 * reconcile must never undeploy them (they are absent from the hub's
 * installed-addon set and would otherwise look "stale"):
 *   - `@camstack/system`        — storage/settings/metrics/logging builtins.
 *   - `@camstack/addon-agent-ui` — the agent's own status dashboard
 *     (placement: agent-only; the hub never installs it, so it is missing
 *     from `hubPlacements`). The hub's deploy planner already SKIPS
 *     agent-only addons, so undeploying one is a reconcile asymmetry bug.
 *
 * The hub keeps this explicit allowlist rather than importing
 * `AddonInstaller.AGENT_PACKAGES` (agent-role bootstrap plumbing) into the
 * registry service — the reconcile only needs the agent-only addon names to
 * skip them, so a small local set keeps the two concerns decoupled.
 */
const AGENT_BOOTSTRAP_PACKAGES: ReadonlySet<string> = new Set([
  '@camstack/system',
  '@camstack/addon-agent-ui',
])

/** Shape of one addon entry in the `$agent.status` response. */
interface AgentStatusAddon {
  readonly id: string
  readonly status?: string
  readonly version?: string
  readonly packageName?: string
}

/** Derive the package roster (name → version) from a node's addon list. */
function rosterFromAddons(addons: readonly AgentStatusAddon[]): readonly NodePackageEntry[] {
  const byName = new Map<string, NodePackageEntry>()
  for (const addon of addons) {
    if (addon.packageName === undefined || addon.packageName.length === 0) continue
    const existing = byName.get(addon.packageName)
    // Prefer an entry that carries a version — sibling addons of one package
    // report the same package version, but a degraded one may omit it.
    if (existing !== undefined && existing.version !== null) continue
    byName.set(addon.packageName, {
      name: addon.packageName,
      version: addon.version !== undefined && addon.version.length > 0 ? addon.version : null,
    })
  }
  return [...byName.values()]
}

/**
 * Narrow typed view of the Moleculer broker — its own `.d.ts` chains
 * through eventemitter2 and resolves to `error`, tripping the
 * `no-unsafe-*` rules. One documented cast through this interface
 * (see the `broker` getter) keeps every call site type-safe.
 */
interface ReconcileBrokerLike {
  call(
    action: string,
    params?: Record<string, unknown>,
    options?: { nodeID?: string; timeout?: number },
  ): Promise<unknown>
  waitForServices(services: string[], timeout?: number): Promise<unknown>
  localBus: {
    on(event: string, handler: (payload: { node: { id: string } }) => void): void
  }
  /**
   * The node catalog hangs off the same broker, so it comes through the same
   * documented cast. It was briefly given a second one of its own; two casts
   * of one object are two chances to describe it differently.
   */
  readonly registry?: NodeCatalogRegistryLike
}

/** Registry-node subset the liveness mapper consumes (moleculer `Node`). */
interface RegistryNodeSnapshot {
  readonly id: string
  readonly available: boolean
}

/**
 * Map raw Moleculer registry nodes to the health-surface liveness rows.
 * Child runner ids (`hub/foo`, `agent/bar`) are processes, not cluster
 * nodes — excluded, same rule as `listNodes()` / `classifyNode`.
 */
export function toNodeLiveness(nodes: readonly RegistryNodeSnapshot[]): readonly NodeLiveness[] {
  return (
    nodes
      // A Moleculer registry can transiently hold a malformed entry with no id
      // (seen live 2026-07-16 after agent churn): guard it or every consumer of
      // this projection 500s on `undefined.includes`.
      .filter((node) => typeof node.id === 'string' && !node.id.includes('/'))
      .map((node) => ({
        id: node.id,
        isHub: node.id === 'hub',
        isOnline: node.available,
      }))
  )
}

/**
 * Project a live `AgentListItem` into the durable history descriptor. Field
 * derivations mirror `computeTopology` exactly (engines from `pythonRuntimes`,
 * cpuModel `undefined`→`null`, addonIds from the reported `agentAddons`) so an
 * offline row rendered from history is indistinguishable from the live shape.
 */
export function toDescriptor(entry: AgentListItem): ClusterNodeDescriptor {
  return {
    id: entry.info.id,
    name: entry.info.name,
    hostname: entry.info.hostname ?? entry.info.id,
    platform: entry.info.platform ?? 'unknown',
    arch: entry.info.arch ?? 'unknown',
    cpuModel: entry.info.cpuModel ?? null,
    cpuCores: entry.info.cpuCores ?? 0,
    memoryMB: entry.info.memoryMB ?? 0,
    engines: [...(entry.info.pythonRuntimes ?? [])],
    isHub: entry.isHub,
    localIps: [...(entry.localIps ?? [])],
    addonIds: [...(entry.agentAddons ?? [])],
  }
}

/**
 * Narrow one `$process.list` row to the sub-process shape the topology
 * projection reads. `$process.*` is an untyped Moleculer infra boundary; the
 * process-service owns the real `ProcessInfo` shape.
 */
function toSubProcess(p: Record<string, unknown>): Record<string, unknown> {
  return {
    pid: (p.pid as number) ?? 0,
    name: (p.name as string) ?? '',
    command: 'moleculer-service',
    state: (p.state as 'running' | 'stopped' | 'crashed') ?? 'running',
    cpuPercent: (p.cpuPercent as number) ?? 0,
    memoryRss: (p.memoryRss as number) ?? 0,
    uptimeSeconds: (p.uptimeSeconds as number) ?? 0,
    addonIds: (p.addonIds as readonly string[] | undefined) ?? [],
    groupId: (p.groupId as string | undefined) ?? null,
  }
}

export class AgentRegistryService {
  // Role assignments: key = `${cameraId}:${role}`
  private readonly assignments: Map<string, CameraRoleAssignment> = new Map()
  private readonly bootTimestamp = Date.now()

  /**
   * Hub addon registry — the source of truth for which addons are
   * installed and their `execution.placement`. Injected via
   * `setAddonRegistry()` rather than the constructor because
   * `AddonRegistryService` is built AFTER this service in the boot
   * order (see `manual-boot.ts`).
   */
  private addonRegistry: AddonRegistryService | null = null

  /**
   * Durable, routing-blind offline-node history (A1). Separate from
   * `HubNodeRegistry` on purpose — see `cluster-node-history-store.ts`. Wired
   * post-construction from manual-boot so the 3-arg constructor (and its unit
   * fakes) stay untouched; a null store means "history disabled" (best-effort).
   */
  private historyStore: ClusterNodeHistoryStore | null = null

  /**
   * The history as last read successfully — fed by every topology pass
   * (`getClusterNodeHistory`), served to `nodes.directory` (D637).
   */
  private historyMirror: ClusterNodeHistoryMirror | null = null

  /**
   * Scoped logger, wired post-construction from `manual-boot` for the same
   * reason as the seams above (the logging service is built earlier but the
   * 3-arg constructor and its unit fakes stay untouched). `null` in fakes —
   * every use is optional-chained, so a fake never has to grow a logger.
   */
  private logger: IScopedLogger | null = null

  /**
   * Side-effecting half of the addon back-fill (pack → `$agent.deploy` →
   * `$agent.reload`). Wired post-construction from `manual-boot` because it
   * needs `AddonPackageService`, which is built in a later layer. `null` means
   * "back-fill disabled" — the reconcile then behaves exactly as it did before
   * (undeploy-only), which is what unit fakes and the agent role rely on.
   */
  private addonBackfill: BackfillSeam | null = null

  /**
   * Bounded per-`(node, package)` delivery breaker — see
   * `agent-addon-backfill.ts`. Process-scoped, holds no intent.
   */
  private readonly backfillTracker = new BackfillAttemptTracker()

  /**
   * "Is the hub writing addons to this node right now?" — the gate that stops
   * the back-fill reacting to a roster gap the hub itself opened. Public so the
   * delivery path (`deliverAddonToAgent`) can mark its own window; see
   * `agent-delivery-ledger.ts` for why a delivery makes the roster lie.
   */
  readonly deliveryLedger = new AgentDeliveryLedger()

  /**
   * Nodes with a reconcile in flight. The pass is triggered from two places
   * (the `registerNode` ack and the hub-boot sweep) and a reconnect can fire
   * both within one tick; without this guard two passes would compute the same
   * diff and each deliver it.
   */
  private readonly reconcilingNodes = new Set<string>()

  constructor(
    private readonly eventBus: EventBusService,
    private readonly moleculer: MoleculerService,
    private readonly capabilityService: CapabilityService,
  ) {}

  /** Wire the hub addon registry once it has been constructed. */
  setAddonRegistry(addonRegistry: AddonRegistryService): void {
    this.addonRegistry = addonRegistry
  }

  /**
   * Wire what runs AFTER a node is really forgotten: the `node-removal-hook`
   * dispatch and the hub-owned node-scoped data (#265). It never runs for a
   * refused or a no-op forget.
   */
  setNodeRemovalCleanup(cleanup: (nodeId: string, removedAt: number) => Promise<void>): void {
    this.nodeRemovalCleanup = cleanup
  }

  private nodeRemovalCleanup: ((nodeId: string, removedAt: number) => Promise<void>) | null = null

  /**
   * Wire the revocation of a forgotten node's mesh certificates (D857). Injected so this service
   * never imports the pairing router; unwired reads as `registry-unavailable`.
   */
  setNodeCertificateRevoker(revoker: NodeCertificateRevoker): void {
    this.nodeCertificateRevoker = revoker
  }

  private nodeCertificateRevoker: NodeCertificateRevoker | null = null

  private async revokeForgottenNodeCertificates(
    nodeId: string,
  ): Promise<NodeCertificateRevocation> {
    let revocation: NodeCertificateRevocation
    try {
      const serials =
        (await this.nodeCertificateRevoker?.(nodeId, FORGOTTEN_NODE_REVOCATION_REASON)) ?? null
      revocation =
        serials === null
          ? { outcome: 'registry-unavailable' }
          : { outcome: 'revoked', serials: [...serials] }
    } catch (err: unknown) {
      revocation = {
        outcome: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
    }
    if (revocation.outcome === 'revoked') {
      this.logger?.info('node forgotten: certificates revoked', {
        tags: { nodeId },
        meta: { serials: revocation.serials },
      })
    } else {
      this.logger?.warn('node forgotten: certificates were NOT revoked', {
        tags: { nodeId },
        meta: { outcome: revocation.outcome },
      })
    }
    return revocation
  }

  /** Wire the durable offline-node history store (A1). */
  setClusterNodeHistoryStore(store: ClusterNodeHistoryStore): void {
    this.historyStore = store
    this.historyMirror = new ClusterNodeHistoryMirror(() => store.tryGetAll())
  }

  /** Wire the scoped logger (boot order — see the field). */
  setLogger(logger: IScopedLogger): void {
    this.logger = logger
  }

  /** Wire (or clear) the addon back-fill delivery seam. */
  setAddonBackfill(seam: BackfillSeam | null): void {
    this.addonBackfill = seam
  }

  /**
   * Delivery failures the breaker is tracking for a node — surfaced so a node
   * that is missing capabilities never merely *looks* healthy.
   */
  getBackfillFailures(nodeId: string): readonly BackfillFailureRecord[] {
    return this.backfillTracker.failuresFor(nodeId)
  }

  /**
   * Record that an addon was deliberately removed from a node, so the back-fill
   * does not put it straight back on the next reconnect.
   *
   * This is the ONLY way a node's intended set shrinks. Called from the
   * operator's `nodes.undeployAddon` and from the stale-addon reconcile. The
   * addon DECLARATION id is resolved to its package through the hub registry,
   * because delivery — and therefore the record — is per package.
   */
  async noteAddonUndeployed(nodeId: string, addonId: string): Promise<void> {
    const packageName = this.resolvePackageForAddon(addonId)
    if (packageName === null) return
    if (AGENT_BOOTSTRAP_PACKAGES.has(packageName)) return
    await this.historyStore?.prunePackages(nodeId, [packageName])
  }

  /**
   * The operator removed a whole PACKAGE from a node (`addons.uninstallPackage`
   * with a `nodeId`, or `everywhere`). Same intent as
   * {@link noteAddonUndeployed}, keyed by package — which is what an uninstall
   * names, and the only key that still resolves once the hub itself no longer
   * has the package. Emits one `AddonUninstalled` per addon removed, like the
   * stale-addon reconcile does.
   */
  async notePackageUndeployed(
    nodeId: string,
    packageName: string,
    addonIds: readonly string[],
  ): Promise<void> {
    if (AGENT_BOOTSTRAP_PACKAGES.has(packageName)) return
    await this.historyStore?.prunePackages(nodeId, [packageName])
    for (const addonId of addonIds) {
      this.eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'core', id: 'agent-registry' },
        category: EventCategory.AddonUninstalled,
        data: {
          addonId,
          agentId: nodeId,
          packageName,
          reason: 'operator uninstall',
        },
      })
    }
  }

  /** The packages a node last declared (its intended set). `[]` with no store. */
  async getRecordedPackages(nodeId: string): Promise<readonly NodePackageEntry[]> {
    return this.historyStore ? this.historyStore.getPackages(nodeId) : []
  }

  /** Map an addon declaration id to the package that ships it, via the hub registry. */
  private resolvePackageForAddon(addonId: string): string | null {
    if (!this.addonRegistry) return null
    for (const row of this.addonRegistry.listAddons()) {
      if (row.manifest.id !== addonId) continue
      const packageName = row.manifest.packageName
      return typeof packageName === 'string' && packageName.length > 0 ? packageName : null
    }
    return null
  }

  /**
   * Read the durable offline-node history — consumed by `computeTopology`
   * to render OFFLINE rows for nodes no longer in the live Moleculer window.
   * Returns `[]` when no history store is wired (unit fakes).
   */
  async getClusterNodeHistory(): Promise<readonly PersistedClusterNode[]> {
    // A fresh read each pass (topology semantics unchanged), and it feeds the
    // mirror `listNodeDirectory` serves.
    return this.historyMirror ? ((await this.historyMirror.refresh()) ?? []) : []
  }

  /**
   * Permanently forget a node (inline "Forget node") — and report what that
   * actually removed.
   *
   * A topology row for an absent node has TWO sources, and forgetting one of
   * them changes nothing the operator can see:
   *
   *  1. the durable history row (this store), projected by `computeTopology`
   *     for nodes no longer in the live Moleculer window, and
   *  2. Moleculer's OWN node catalog, which `listNodes()` reads with
   *     `onlyAvailable: false` and renders through `buildOfflineEntry`.
   *
   * Until 2026-09-01 only (1) was purged, and the answer was an unconditional
   * `{success: true}`. `hub-test` had its history row deleted repeatedly and
   * stayed on the Cluster page every time, because (2) still held it —
   * Moleculer purges an offline node on its own 10-minute sweep only while
   * nothing re-announces it, and the operator has no reason to wait for a
   * timer they cannot see.
   *
   * An ONLINE node is forgotten too (operator ruling 2026-10-29, D966). The old refusal said a
   * live node re-registers at once; since D857 its leaf is on the CRL, so it cannot. The order
   * matters: (1) revoke (the revoker also closes the node's mutual-TLS sockets, because the CRL is
   * only read at a handshake), (2) `disconnected` in the catalog, which unregisters its services and
   * rejects the cap calls still waiting on it with `RequestRejectedError` - a bare `nodes.delete`
   * would leave both behind, (3) the delete and the rest of the cleanup. The agent finds out on
   * its own: refused at the next handshake, it asks the hub (`agent-membership-watch`) and resets
   * to unpaired after two CA-signed `revoked` answers. `stillListed` is read back at the end, so a
   * node that came straight back (revocation failed) is reported as listed, never as forgotten.
   */
  async forgetClusterNode(nodeId: string): Promise<ForgetClusterNodeResult> {
    // First: a forgotten node whose leaf stays valid walks back in on its next boot (D857).
    const certificates = await this.revokeForgottenNodeCertificates(nodeId)

    const historyOutcome = this.historyStore
      ? await this.historyStore.forget(nodeId)
      : 'store-unavailable'
    // The mirror still lists the forgotten node: the next directory re-reads.
    this.historyMirror?.invalidate()
    if (this.isNodeOnline(nodeId)) this.disconnectFromNodeCatalog(nodeId)
    const registryRemoved = this.removeFromNodeCatalog(nodeId)
    // Its intended set is gone with the row, so the back-fill breaker's memory
    // of failed deliveries to it is meaningless — drop it too.
    this.backfillTracker.forget(nodeId)
    this.deliveryLedger.forget(nodeId)
    // The names the hub certified to this node are free again (a forgotten node cannot hold them).
    await getProcessAgentHttpsNames()
      ?.release(nodeId)
      .catch((err: unknown) =>
        this.logger?.warn("forget cluster node: could not release the node's certified names", {
          tags: { nodeId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        }),
      )

    const historyRemoved = historyOutcome === 'removed'
    const stillListed = this.isNodeKnown(nodeId)
    const message =
      describeForgetOutcome(nodeId, historyOutcome, registryRemoved, stillListed) +
      describeRevocation(certificates)
    this.logger?.info('forget cluster node', {
      tags: { nodeId },
      meta: { historyOutcome, historyRemoved, registryRemoved, stillListed },
    })
    // Topology is push-only (`cluster.topology-snapshot`). Without this event
    // the Cluster page kept the forgotten row until the 30 s heartbeat — the
    // operator had to refresh by hand. `TopologyEmitterService` listens for
    // `AgentUnregistered` and re-emits immediately.
    if (historyRemoved || registryRemoved) {
      // The recorded fact the owners of node-scoped data are driven from. A
      // failure here must not turn a forget that happened into an error.
      try {
        await this.nodeRemovalCleanup?.(nodeId, Date.now())
      } catch (err: unknown) {
        this.logger?.warn('node removal cleanup failed', {
          tags: { nodeId },
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      }
      this.eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'core', id: 'agent-registry' },
        category: EventCategory.AgentUnregistered,
        data: { agentId: nodeId },
      })
    }
    return {
      forgotten: historyRemoved || registryRemoved,
      historyRemoved,
      registryRemoved,
      stillListed,
      certificates,
      message,
    }
  }

  /**
   * Take a LIVE node out of routing the way Moleculer does when its transport drops: services
   * unregistered, pending requests rejected (typed, not left to time out). Idempotent.
   */
  private disconnectFromNodeCatalog(nodeId: string): void {
    const nodes = this.nodeCatalogRegistry()?.nodes
    if (nodes?.disconnected === undefined) {
      this.logger?.warn('cluster node catalog does not expose disconnected - calls may hang', {
        tags: { nodeId },
      })
      return
    }
    nodes.disconnected(nodeId, false)
  }

  /** Is the node currently AVAILABLE in Moleculer's catalog? */
  private isNodeOnline(nodeId: string): boolean {
    return this.catalogNodeIds({ onlyAvailable: true }).includes(nodeId)
  }

  /** Is the node in Moleculer's catalog at all (available or not)? */
  private isNodeKnown(nodeId: string): boolean {
    return this.catalogNodeIds({ onlyAvailable: false }).includes(nodeId)
  }

  private catalogNodeIds(opts: { readonly onlyAvailable: boolean }): readonly string[] {
    const registry = this.nodeCatalogRegistry()
    return (registry?.getNodeList?.(opts) ?? []).map((n) => n.id)
  }

  /**
   * Drop a node from Moleculer's own catalog — the SAME call Moleculer's
   * discoverer makes in `checkOfflineNodes` once an offline node ages out. It
   * is safe here for exactly the same reason it is safe there: the node is not
   * available, so nothing is routing to it, and a node that comes back
   * re-announces itself and is re-added.
   */
  private removeFromNodeCatalog(nodeId: string): boolean {
    if (!this.isNodeKnown(nodeId)) return false
    const registry = this.nodeCatalogRegistry()
    const nodes = registry?.nodes
    if (nodes?.delete === undefined) {
      this.logger?.warn('cluster node catalog does not expose delete — row may persist', {
        tags: { nodeId },
      })
      return false
    }
    return nodes.delete(nodeId) === true
  }

  /** Typed view of the broker's node catalog — reached through the ONE cast. */
  private nodeCatalogRegistry(): NodeCatalogRegistryLike | undefined {
    return this.broker.registry
  }

  /** Typed view of the Moleculer broker — single documented cast. */
  private get broker(): ReconcileBrokerLike {
    return this.moleculer.broker as ReconcileBrokerLike
  }

  onModuleInit(): void {
    const classifyNode = (id: string): 'agent' | 'worker' | null => {
      if (id === 'hub') return null
      if (id.includes('/')) return 'worker'
      return 'agent'
    }

    // D3: reconcile placement when an agent completes the $hub.registerNode
    // handshake — the manifest is authoritative and complete at that point,
    // no grace delay needed. MoleculerService fires this callback from its
    // onRegisterNode dep for every bare-ID agent node.
    this.moleculer.setOnAgentRegistered((agentId) => {
      void this.reconcileAgentAddons(agentId, 'node-registration')
    })

    this.broker.localBus.on('$node.connected', ({ node }: { node: { id: string } }) => {
      const kind = classifyNode(node.id)
      if (!kind) return
      if (kind === 'agent') {
        console.log(`[agent-registry] Agent connected: ${node.id}`)
        const nodeName = this.knownNodeName(node.id)
        this.eventBus.emit({
          id: randomUUID(),
          timestamp: new Date(),
          source: { type: 'core', id: 'agent-registry' },
          category: EventCategory.AgentOnline,
          data: {
            agentId: node.id,
            ...(nodeName !== undefined ? { nodeName } : {}),
          },
        })
      } else {
        this.eventBus.emit({
          id: randomUUID(),
          timestamp: new Date(),
          source: { type: 'core', id: 'agent-registry' },
          category: EventCategory.WorkerOnline,
          data: { workerId: node.id },
        })
      }
    })

    this.broker.localBus.on(
      '$node.disconnected',
      ({ node, unexpected }: { node: { id: string }; unexpected?: boolean }) => {
        const kind = classifyNode(node.id)
        if (!kind) return
        if (kind === 'agent') {
          console.log(
            `[agent-registry] Agent disconnected: ${node.id}${unexpected === true ? ' (unexpected)' : ''}`,
          )
          // A1: stamp the disconnect time as the node's `lastActive` so its
          // offline row reports an honest "last seen". Best-effort, no-op if the
          // node was never snapshotted while online.
          void this.historyStore?.touch(node.id)
          this.eventBus.emit({
            id: randomUUID(),
            timestamp: new Date(),
            source: { type: 'core', id: 'agent-registry' },
            category: EventCategory.AgentOffline,
            data: agentOfflineData(node.id, unexpected, this.knownNodeName(node.id)),
          })
        } else {
          this.eventBus.emit({
            id: randomUUID(),
            timestamp: new Date(),
            source: { type: 'core', id: 'agent-registry' },
            category: EventCategory.WorkerOffline,
            data: { workerId: node.id },
          })
        }
      },
    )

    // Retroactive scan: emit lifecycle events for nodes already
    // connected when the listener registers. Classifies each as
    // agent or worker — same logic as the live handlers above.
    try {
      const registry = this.nodeCatalogRegistry()
      const existing = registry?.getNodeList?.({ onlyAvailable: true }) ?? []
      for (const { id } of existing) {
        const kind = classifyNode(id)
        if (!kind) continue
        if (kind === 'agent') {
          this.eventBus.emit({
            id: randomUUID(),
            timestamp: new Date(),
            source: { type: 'core', id: 'agent-registry' },
            category: EventCategory.AgentOnline,
            data: { agentId: id },
          })
        } else {
          this.eventBus.emit({
            id: randomUUID(),
            timestamp: new Date(),
            source: { type: 'core', id: 'agent-registry' },
            category: EventCategory.WorkerOnline,
            data: { workerId: id },
          })
        }
      }
    } catch {
      // Registry shape varies across Moleculer versions — never fatal.
    }
  }

  /** The durable history's display name for a node, when it knows a real one. */
  private knownNodeName(nodeId: string): string | undefined {
    return nodeDisplayName(nodeId, this.historyMirror?.peek() ?? null)
  }

  // ---- Placement reconciliation ----

  /**
   * Boot-time reconciliation pass. Agents already connected when the hub
   * starts never fire a fresh `$node.connected` event, so the per-connect
   * trigger would miss them — this method walks the current node list once
   * and reconciles every connected agent. Must be invoked AFTER
   * `AddonRegistryService.onModuleInit()` so the hub's installed-addon set
   * is populated. Per-agent failures are isolated — one unreachable agent
   * must not abort the pass or hub boot.
   */
  async reconcileConnectedAgents(): Promise<void> {
    const registry = this.nodeCatalogRegistry()
    const nodes = registry?.getNodeList?.({ onlyAvailable: true }) ?? []
    const agentIds = nodes
      .map((n) => n.id)
      .filter((id) => typeof id === 'string' && id !== 'hub' && !id.includes('/'))
    if (agentIds.length === 0) return
    console.log(`[agent-registry] Boot reconcile: ${agentIds.length} connected agent(s)`)
    for (const agentId of agentIds) {
      await this.reconcileAgentAddons(agentId, 'hub-boot')
    }
  }

  /**
   * Operator-invoked repair — "this node is missing addons, put them back".
   *
   * The explicit half of the back-fill's trigger set. Everything automatic is
   * gated on a node ASKING (a registration) and on the hub not being mid-write;
   * this is the escape hatch for the case those gates decline, and it is an
   * attributable gesture rather than a heuristic. It does exactly what the
   * automatic pass does — no extra powers, so nothing can be repaired by hand
   * that the node could not converge to on its own.
   */
  async repairNodeAddons(agentId: string): Promise<void> {
    console.log(`[agent-registry] Repair requested by operator for ${agentId}`)
    await this.reconcileAgentAddons(agentId, 'operator-repair')
  }

  /**
   * Reconcile a single agent's deployed addons against the hub's installed
   * set + placements. An addon running on the agent is STALE — and must be
   * undeployed — when it is either:
   *   - not installed on the hub at all, or
   *   - installed but declared `execution.placement: 'hub-only'`.
   *
   * `agent-only` / `any-node` addons that ARE installed on the hub are
   * legitimate agent residents and left untouched.
   *
   * Matching is by addon DECLARATION id: `$agent.status` reports
   * `addons[].id` (the decl id), and the hub's `listAddons()` rows expose
   * the same decl id at `manifest.id`. Package names are NOT used for the
   * match — a single package can ship multiple addons with distinct ids
   * and placements.
   *
   * Version-skew exception: a decl-id the hub has never heard of is NOT
   * stale when the hub already ships that addon's PACKAGE. A newer agent
   * bundle can add a decl-id within a package the hub also ships (e.g. a
   * new `decoder-nodeav` inside `@camstack/addon-pipeline`); undeploying
   * it would delete the whole shared bundle dir on the agent and crash
   * every sibling runner. Only a decl-id whose PACKAGE is absent from the
   * hub is treated as genuinely stale.
   *
   * SECOND DIRECTION — back-fill. The pass is not only a remover: after the
   * stale sweep it converges the node UP to the roster that node itself last
   * declared (`ClusterNodeHistoryStore.getPackages`), delivering whatever is
   * missing. Without it a node whose addons dir was wiped came back with only
   * its bootstrap packages and the hub never sent the rest — 4 of 14 on
   * `agent-a`, measured. Under the volume-only image that empty state is
   * the ordinary first boot of every rebuilt node. See `agent-addon-backfill.ts`
   * for what defines the intended set and how retries are bounded.
   *
   * All errors are caught and logged so a single bad agent never breaks
   * the caller (connect handler or boot pass).
   */
  async reconcileAgentAddons(
    agentId: string,
    trigger: BackfillTrigger = 'node-registration',
  ): Promise<void> {
    if (!this.addonRegistry) {
      console.warn(`[agent-registry] Reconcile skipped for ${agentId}: addon registry not wired`)
      return
    }
    // Re-entrancy guard: the registration ack and the hub-boot sweep can both
    // fire for one node, and a second pass would recompute the same diff and
    // deliver it again while the first is still shipping bytes.
    if (this.reconcilingNodes.has(agentId)) {
      console.log(`[agent-registry] Reconcile ${agentId}: already in flight — skipping`)
      return
    }
    this.reconcilingNodes.add(agentId)
    try {
      const broker = this.broker
      // The reconcile fires the moment `$hub.registerNode` acks, which can race
      // ahead of Moleculer's service-discovery INFO packet for the agent — a
      // bare call then fails with "Service '$agent.status' is not found". Wrap
      // it so a discovery miss waits for the `$agent` service (the framework's
      // waitForServices primitive) and retries once, instead of giving up and
      // leaving the agent unreconciled until the next connect. (No timers/backoff
      // — that's banned for node readiness; this is the sanctioned primitive.)
      const statusRaw = await callWithServiceDiscovery(
        broker,
        '$agent',
        '$agent.status',
        {},
        {
          nodeID: agentId,
          timeout: AGENT_RECONCILE_RPC_TIMEOUT_MS,
        },
      )
      const agentAddons = this.extractAgentAddons(statusRaw)
      // `null` = the node answered with no parseable `addons` array. That is a
      // broken status, NOT an empty node: acting on it would undeploy nothing
      // (fine) but would back-fill the node's ENTIRE roster (not fine). Fail
      // closed and say so.
      if (agentAddons === null) {
        console.warn(
          `[agent-registry] Reconcile ${agentId}: $agent.status carried no addon list — skipping (no undeploy, no back-fill)`,
        )
        return
      }

      // Build the hub's placement map: decl id → placement. Absence from
      // this map means "not installed on the hub". Also collect the set of
      // PACKAGE names the hub ships — used by the version-skew guard below —
      // and the version the hub runs, which is the back-fill's pin source.
      const hubPlacements = new Map<string, ReturnType<typeof resolveAddonPlacement>>()
      const hubPackages = new Set<string>()
      const hubVersions = new Map<string, string>()
      const hubPackagePlacements = new Map<string, AddonPlacement[]>()
      for (const row of this.addonRegistry.listAddons()) {
        const declId = row.manifest.id
        if (typeof declId !== 'string') continue
        const decl = row.declaration ?? row.manifest
        hubPlacements.set(declId, resolveAddonPlacement(decl))
        const packageName = row.manifest.packageName
        if (typeof packageName === 'string' && packageName.length > 0) {
          hubPackages.add(packageName)
          const siblings = hubPackagePlacements.get(packageName) ?? []
          siblings.push(resolveAddonPlacement(decl))
          hubPackagePlacements.set(packageName, siblings)
          const packageVersion = row.manifest.packageVersion
          if (typeof packageVersion === 'string' && packageVersion.length > 0) {
            hubVersions.set(packageName, packageVersion)
          }
        }
      }

      const stale = agentAddons.filter((addon) => {
        // Agent bootstrap infrastructure (storage/settings/metrics/logging from
        // `@camstack/system`, plus the agent-only `addon-agent-ui` dashboard)
        // runs on every node as bootstrap infrastructure — never hub-managed
        // deploy targets, must never be undeployed. Without this guard the
        // reconcile tears down the agent's own builtins (they aren't in the
        // hub's installed-addon set, so they look "stale"), which bricks the
        // agent and makes it permanently unroutable. See AGENT_BOOTSTRAP_PACKAGES.
        if (addon.packageName !== undefined && AGENT_BOOTSTRAP_PACKAGES.has(addon.packageName)) {
          return false
        }
        const placement = hubPlacements.get(addon.id)
        if (placement === undefined) {
          // decl-id unknown to the hub. If the hub ships this PACKAGE, this is a
          // version-skew sibling (a newer agent bundle added a decl-id within a
          // package the hub already ships) — undeploying it would delete the whole
          // shared bundle on the agent. Only undeploy when the PACKAGE itself is
          // absent from the hub.
          if (addon.packageName !== undefined && hubPackages.has(addon.packageName)) return false
          return true
        }
        // Installed but pinned to the hub → must not run on an agent.
        return placement === 'hub-only'
      })

      if (stale.length === 0) {
        console.log(
          `[agent-registry] Reconcile ${agentId}: no stale addons (${agentAddons.length} checked)`,
        )
      }

      // Packages fully removed from the node by this pass. Recorded so the
      // back-fill below cannot immediately put them back, and so the node's
      // intended set shrinks — the only way that happens.
      const undeployedPackages = new Set<string>()
      const survivingIds = new Set(agentAddons.filter((a) => !stale.includes(a)).map((a) => a.id))

      for (const addon of stale) {
        const reason = hubPlacements.has(addon.id)
          ? 'placement is hub-only'
          : 'not installed on hub'
        try {
          await broker.call(
            '$agent.undeploy',
            { addonId: addon.id },
            {
              nodeID: agentId,
              timeout: AGENT_RECONCILE_RPC_TIMEOUT_MS,
            },
          )
          console.log(
            `[agent-registry] Reconcile ${agentId}: undeployed stale addon "${addon.id}" (${reason})`,
          )
          // A package only leaves the intended set when NO surviving addon
          // still belongs to it — one package ships many addons, and the agent
          // keeps the bundle dir while a sibling is still loaded.
          const packageName = addon.packageName
          if (packageName !== undefined && packageName.length > 0) {
            const siblingSurvives = agentAddons.some(
              (a) => a.packageName === packageName && survivingIds.has(a.id),
            )
            if (!siblingSurvives) undeployedPackages.add(packageName)
          }
          this.eventBus.emit({
            id: randomUUID(),
            timestamp: new Date(),
            source: { type: 'core', id: 'agent-registry' },
            category: EventCategory.AddonUninstalled,
            data: { addonId: addon.id, agentId, reason },
          })
        } catch (err) {
          console.error(
            `[agent-registry] Reconcile ${agentId}: failed to undeploy "${addon.id}":`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }

      await this.backfillAgentAddons(
        agentId,
        agentAddons,
        undeployedPackages,
        hubVersions,
        hubPackagePlacements,
        trigger,
      )
    } catch (err) {
      console.error(
        `[agent-registry] Reconcile failed for agent ${agentId}:`,
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      this.reconcilingNodes.delete(agentId)
    }
  }

  /**
   * Converge a node UP to the roster it last declared.
   *
   * Order matters and is deliberate:
   *   1. record what the node declares NOW (grow-only merge) — a wiped node
   *      reporting 4 packages must not erase the record of its 14;
   *   2. prune what this pass undeployed — the intended set's only shrink;
   *   3. read the resulting intended set and deliver the difference.
   *
   * Every leg is idempotent: run twice with no change in between and step 3
   * finds nothing to do.
   */
  private async backfillAgentAddons(
    agentId: string,
    agentAddons: readonly AgentStatusAddon[],
    undeployedPackages: ReadonlySet<string>,
    hubVersions: ReadonlyMap<string, string>,
    hubPackagePlacements: ReadonlyMap<string, readonly AddonPlacement[]>,
    trigger: BackfillTrigger,
  ): Promise<void> {
    const store = this.historyStore
    if (!store) return

    // Read BEFORE recording: a fresh node is one that never declared a roster
    // (D962), and the record below would make it look like it had one.
    const priorRoster = await store.getPackages(agentId)
    const live = rosterFromAddons(agentAddons)
    await store.recordPackages(agentId, live)
    if (undeployedPackages.size > 0) {
      await store.prunePackages(agentId, [...undeployedPackages])
    }

    const seam = this.addonBackfill
    if (!seam) return

    const recorded = await store.getPackages(agentId)
    const planned = computeBackfillPlan({
      recorded,
      live,
      bootstrap: AGENT_BOOTSTRAP_PACKAGES,
      undeployed: undeployedPackages,
      retired: this.backfillTracker.retiredFor(agentId),
      hubVersions,
      freshNode: priorRoster.length === 0 ? { hubPackagePlacements } : undefined,
    })

    if (priorRoster.length === 0) {
      this.logger?.info(
        'back-fill: fresh node (no prior declared roster), plan from the hub any-node set',
        {
          tags: { nodeId: agentId },
          meta: {
            planned: planned.targets.map((t) => `${t.name}@${t.version}`),
          },
        },
      )
      for (const skip of planned.skipped) {
        this.logger?.info('back-fill: fresh node not given a hub package', {
          tags: { nodeId: agentId },
          meta: { package: skip.name, reason: skip.reason },
        })
      }
    }

    // Never a delivery, and said so: an addon the hub no longer installs stays
    // off the node even though the node once declared it (the stale sweep above
    // removes a copy that is still there).
    if (planned.notOnHub.length > 0) {
      console.log(
        `[agent-registry] Back-fill ${agentId}: NOT delivering ${planned.notOnHub.join(', ')} — ` +
          `in the node's declared roster but not installed on the hub`,
      )
    }

    if (planned.targets.length === 0 && planned.retired.length === 0) {
      return
    }

    // GATE 1 — the trigger allowlist. A pass that must not install says so and
    // stops; silence here would read as "nothing was missing".
    if (!triggerMayDeliver(trigger)) {
      console.log(
        `[agent-registry] Back-fill ${agentId}: SKIPPED — trigger "${trigger}" may not deliver ` +
          `(${planned.targets.length} package(s) would have been installed)`,
      )
      return
    }

    // GATE 2 — the delivery window. A roster gap the hub itself opened is not
    // evidence a node is missing anything. This is the trigger that made every
    // `camstack deploy … -n <agent>` on 2026-08-07 get reverted ~1.5s later.
    const suppression = this.deliveryLedger.suppressionFor(agentId)
    if (suppression !== null) {
      console.log(
        `[agent-registry] Back-fill ${agentId}: SKIPPED — a hub delivery to this node is ` +
          `in flight or just finished (inFlight=${suppression.inFlight}, ` +
          `msSinceLastDelivery=${suppression.msSinceLastDelivery ?? 'n/a'}, ` +
          `packages=${suppression.packages.join(', ') || 'none'}); ` +
          `the node reported ${planned.liveCount} package(s) and the roster gap is OURS, not the node's`,
      )
      return
    }

    // GATE 3 — the confirmation read (D49). A back-fill overwrites whatever is
    // on the node, so the destroying direction needs a SECOND read to agree.
    const plan = await this.confirmBackfillTargets(agentId, planned)
    if (plan === null) return
    if (plan.targets.length === 0 && plan.retired.length === 0) {
      return
    }

    // Hold the delivery window open for the whole pass, so the reload this
    // back-fill is about to cause cannot trigger a second one.
    const closeWindow = this.deliveryLedger.begin(
      agentId,
      plan.targets.map((t) => t.name).join(', ') || 'back-fill',
    )
    let outcome
    try {
      outcome = await executeBackfill(seam, agentId, plan, this.backfillTracker)
    } finally {
      closeWindow()
    }

    if (outcome.delivered.length > 0) {
      console.log(
        `[agent-registry] Back-fill ${agentId}: delivered ${outcome.delivered
          .map((d) => {
            const from = live.find((p) => p.name === d.name)?.version ?? 'absent'
            return `${d.name} ${from} → ${d.version} (agent follows the hub installed version)`
          })
          .join(', ')} — trigger=${trigger}, node reported ${plan.liveCount} package(s) and its ` +
          `declared roster has ${recorded.length}`,
      )
      this.eventBus.emit({
        id: randomUUID(),
        timestamp: new Date(),
        source: { type: 'core', id: 'agent-registry' },
        category: EventCategory.AddonInstalled,
        data: {
          agentId,
          packages: outcome.delivered.map((d) => `${d.name}@${d.version}`),
          reason: 'back-fill: node missing packages from its declared roster',
        },
      })
    }
    // Fail LOUD: a node missing capabilities must never merely look healthy.
    for (const failure of outcome.failed) {
      console.error(
        `[agent-registry] Back-fill ${agentId}: FAILED to deliver ${failure.name}@${failure.version} — ${failure.error}` +
          (failure.retired
            ? ` (retired after ${MAX_BACKFILL_ATTEMPTS} attempts; this node is running WITHOUT that package)`
            : ''),
      )
    }
    for (const name of outcome.skipped) {
      console.error(
        `[agent-registry] Back-fill ${agentId}: ${name} is still missing and RETIRED — the node is degraded until an operator intervenes`,
      )
    }
  }

  /**
   * Re-read the node's roster and drop every target the second read reports
   * present ([D49](../../../../docs/decisions/adr-0049.md)).
   *
   * Returns `null` when the second read cannot be trusted — an RPC failure or
   * an unparseable status. Failing CLOSED is the whole point: the first read
   * already said "install these", and a read that fails must not be allowed to
   * look like agreement. The cost of the extra RPC is paid only on a pass that
   * actually wants to install something.
   */
  private async confirmBackfillTargets(
    agentId: string,
    plan: ReturnType<typeof computeBackfillPlan>,
  ): Promise<ReturnType<typeof computeBackfillPlan> | null> {
    if (plan.targets.length === 0) return plan
    let secondRaw: unknown
    try {
      secondRaw = await this.broker.call(
        '$agent.status',
        {},
        { nodeID: agentId, timeout: AGENT_RECONCILE_RPC_TIMEOUT_MS },
      )
    } catch (err) {
      console.warn(
        `[agent-registry] Back-fill ${agentId}: SKIPPED — the confirmation read failed ` +
          `(${err instanceof Error ? err.message : String(err)}); refusing to install over a node ` +
          `on one unconfirmed roster`,
      )
      return null
    }
    const secondAddons = this.extractAgentAddons(secondRaw)
    if (secondAddons === null) {
      console.warn(
        `[agent-registry] Back-fill ${agentId}: SKIPPED — the confirmation read carried no addon list`,
      )
      return null
    }
    const { plan: confirmed, contradicted } = confirmBackfillPlan(
      plan,
      rosterFromAddons(secondAddons),
    )
    if (contradicted.length > 0) {
      console.warn(
        `[agent-registry] Back-fill ${agentId}: confirmation read already has ` +
          `${contradicted.map((t) => `${t.name}@${t.version}`).join(', ')} ` +
          `(or could not read the version). Not installing over that read`,
      )
    }
    return confirmed
  }

  /**
   * Narrow the `$agent.status` response down to its addon list.
   *
   * Returns `null` — not `[]` — when the response carries no parseable addon
   * array. The distinction is load-bearing: `[]` means "this node runs no
   * addons" (act on it), `null` means "this node did not tell us" (do not act).
   */
  private extractAgentAddons(statusRaw: unknown): readonly AgentStatusAddon[] | null {
    if (statusRaw === null || typeof statusRaw !== 'object') return null
    const addons = (statusRaw as { addons?: unknown }).addons
    if (!Array.isArray(addons)) return null
    const result: AgentStatusAddon[] = []
    for (const entry of addons) {
      if (entry === null || typeof entry !== 'object') continue
      const id = (entry as { id?: unknown }).id
      if (typeof id !== 'string' || id.length === 0) continue
      // Preserve `packageName` — the reconcile uses it to skip system builtins,
      // and `version` — the back-fill records it as the node's declared pin.
      const packageName = (entry as { packageName?: unknown }).packageName
      const version = (entry as { version?: unknown }).version
      result.push({
        id,
        packageName: typeof packageName === 'string' ? packageName : undefined,
        version: typeof version === 'string' ? version : undefined,
      })
    }
    return result
  }

  /** Log an agent rename (name changes are persisted via $agent.rename RPC). */
  updateAgentName(nodeId: string, name: string): void {
    console.log(`[agent-registry] Agent renamed: "${nodeId}" → "${name}"`)
  }

  /**
   * Fan-out-free liveness snapshot for the `/health` surface. Reads ONLY
   * the hub's in-memory Moleculer node registry — never a per-node RPC —
   * so a frozen/ghost agent can never slow the hub-liveness probe.
   * (`listNodes()` fans `$agent.status`/`$process.list` out at 5s/node;
   * the admin-ui probe aborts `/health` at 4s, which turned one frozen
   * node into a false RED "Server unreachable" banner — #26.)
   * `onlyAvailable: false` keeps recently-offline nodes listed with
   * `available:false`, which is what populates `agents.offlineIds`.
   */
  listNodeLiveness(): readonly NodeLiveness[] {
    return toNodeLiveness(this.moleculer.broker.registry.getNodeList({ onlyAvailable: false }))
  }

  /**
   * The cheap node list for pickers (D637): the in-memory liveness above plus
   * the durable history — no per-node RPC, unlike `computeTopology` (32–51 s).
   * The history comes from the mirror the topology pass keeps fresh, so a
   * picker open normally costs no settings round trip either. No history
   * store wired, or no read that ever answered, is `complete: false`.
   */
  async listNodeDirectory(): Promise<NodeDirectory> {
    const history = this.historyMirror ? await this.historyMirror.current() : null
    return toNodeDirectory(this.listNodeLiveness(), history)
  }

  async listNodes(): Promise<readonly AgentListItem[]> {
    const registry = this.nodeCatalogRegistry()
    // `onlyAvailable: false` intentionally includes nodes Moleculer still
    // remembers as disconnected (`available: false`) — the same registry
    // read `listNodeLiveness()` uses for `/health`. This surfaces recently
    // offline agents inline instead of silently omitting them; it is NOT a
    // new shadow map (no persistence, no timestamp field added anywhere) —
    // once Moleculer's own `cleanOfflineNodesTimeout` purges the entry, the
    // row disappears again. A hub-restart-surviving offline history is a
    // separate, deliberately deferred piece of work.
    const nodes = registry?.getNodeList?.({ onlyAvailable: false }) ?? []

    // Every node's legs are INDEPENDENT of every other node's, and the hub's
    // own legs are independent of both. Walking them with `await` in a `for`
    // made one read cost the sum of the cluster; they are one wave now
    // (D317). Each leg still fails closed on its own — `allSettled` semantics
    // are preserved by the per-node `catch` inside `buildRemoteEntry`.
    const remoteTargets = nodes.filter(
      (node) => typeof node.id === 'string' && node.id !== 'hub' && !node.id.includes('/'),
      // Skip the hub (built separately), child-process nodes (contain '/'),
      // and malformed registry entries with no id (live 2026-07-16: one such
      // ghost 500'd nodes.topology — the whole Cluster page — until restart).
    )

    const [hubEntry, remoteEntries] = await Promise.all([
      this.listHubProcesses().then((procs) => this.buildHubEntry(procs)),
      Promise.all(
        remoteTargets.map((node) =>
          node.available
            ? // Online: one wave of `$agent.status` + `$process.list`.
              this.buildRemoteEntry(node.id)
            : // Offline: skip the RPC fan-out entirely (the node is unreachable —
              // those calls would just time out) and surface a minimal,
              // honestly-degraded row instead.
              Promise.resolve(this.buildOfflineEntry(node)),
        ),
      ),
    ])

    return [hubEntry, ...remoteEntries.filter((entry): entry is AgentListItem => entry !== null)]
  }

  /** The hub's own runner subprocesses (`$process.list`, hub-local). */
  private async listHubProcesses(): Promise<readonly unknown[]> {
    try {
      const processes = (await this.broker.call('$process.list')) as readonly Record<
        string,
        unknown
      >[]
      return processes.map(toSubProcess)
    } catch {
      // $process service may not be ready yet
      return []
    }
  }

  /**
   * One online agent's row: `$agent.status` for the descriptor + live metrics,
   * `$process.list` for real sub-process stats. `null` when the node has no
   * `$agent` service (it is then simply absent from the list, as before).
   *
   * The two calls are ONE wave, not two: `$process.list` never reads anything
   * from `$agent.status` — only its FALLBACK does, and the fallback is applied
   * after both have settled.
   */
  private async buildRemoteEntry(nodeId: string): Promise<AgentListItem | null> {
    const [statusResult, processResult] = await Promise.allSettled([
      this.broker.call('$agent.status', {}, { nodeID: nodeId, timeout: 5000 }) as Promise<
        Record<string, unknown>
      >,
      this.broker.call('$process.list', {}, { nodeID: nodeId, timeout: 5000 }) as Promise<
        readonly Record<string, unknown>[]
      >,
    ])
    // No `$agent` service — skip the node, exactly as the sequential loop did.
    if (statusResult.status === 'rejected') return null
    const status = statusResult.value

    const subProcesses: readonly unknown[] =
      processResult.status === 'fulfilled'
        ? processResult.value.map(toSubProcess)
        : // Fall back to the addon list from $agent.status (no stats)
          ((status.addons as readonly Record<string, unknown>[] | undefined)?.map((a) => ({
            pid: 0,
            name: (a.id as string) ?? '',
            command: 'moleculer-service',
            state: ((a.status as string) ?? 'running') as 'running' | 'stopped' | 'crashed',
            cpuPercent: 0,
            memoryRss: 0,
            uptimeSeconds: 0,
          })) ?? [])

    // Extract addon IDs from $agent.status
    const agentAddons: readonly string[] =
      (status.addons as readonly { id: string }[] | undefined)?.map((a) => a.id) ?? []

    const hostname = typeof status.hostname === 'string' ? status.hostname : null
    const agentName = typeof status.name === 'string' ? status.name : nodeId
    return {
      info: {
        id: nodeId,
        name: agentName,
        hostname: hostname ?? nodeId,
        capabilities: [],
        platform: (status.platform as string) ?? 'unknown',
        arch: (status.arch as string) ?? 'unknown',
        cpuCores: (status.cpuCores as number) ?? 0,
        memoryMB: (status.totalMemoryMB as number) ?? 0,
        cpuModel: status.cpuModel as string | undefined,
        pythonRuntimes: Array.isArray(status.pythonRuntimes)
          ? (status.pythonRuntimes as readonly string[])
          : [],
      },
      localIps: Array.isArray(status.localIps) ? (status.localIps as string[]) : [],
      status: {
        activeCameras: 0,
        cpuPercent: (status.cpuPercent as number) ?? 0,
        memoryPercent: typeof status.memoryPercent === 'number' ? status.memoryPercent : null,
        processRssBytes: typeof status.processRssBytes === 'number' ? status.processRssBytes : null,
        fps: {},
        errors: [],
      },
      connectedSince:
        typeof status.uptime === 'number'
          ? Date.now() - (status.uptime as number) * 1000
          : Date.now(),
      isHub: false,
      subProcesses,
      agentAddons,
    }
  }

  /**
   * A1 (R2 capture point): snapshot every ONLINE node's static descriptor +
   * last-known addon roster into the durable, routing-blind history store.
   * This is the ONLY place cpuModel/cores/memory/localIps are resolved from a
   * live `$agent.status`, so it is where an offline row's descriptor must be
   * captured while the node is still reachable. Offline entries are NOT
   * re-snapshotted — their `lastActive` is stamped on `$node.disconnected`
   * instead. This is a separate durable store, never a `knownAgents`-style
   * shadow of `HubNodeRegistry` (which stays the ephemeral live cap authority).
   *
   * **It belongs to the PERIODIC PASS, not to a read** (D317). It used to run
   * at the tail of `listNodes()`, which made every operator poll of
   * `nodes.topology` perform one durable read-back — and, past the five-minute
   * heartbeat, one durable write — per online node, in a phase that had to
   * finish before the history read could even start. Measured on the live hub
   * on 2026-08-31: one settings-store round trip cost 14.8–18.3 s and
   * `nodes.topology` cost exactly two of them, 30.5 s. `TopologyEmitterService`
   * already recomputes this picture every 30 s; the capture is its work.
   *
   * Never throws — the store swallows its own errors and this awaits
   * `allSettled` so a storage hiccup can never fail the pass.
   */
  async captureNodeHistory(entries: readonly AgentListItem[]): Promise<void> {
    if (!this.historyStore) return
    const online = entries.filter((e) => e.isOnline !== false)
    await Promise.allSettled(online.map((e) => this.historyStore!.snapshot(toDescriptor(e))))
  }

  /**
   * Minimal, honestly-degraded entry for a node Moleculer's registry still
   * remembers but marks `available: false`. No RPC round-trip is attempted
   * (the node is unreachable by definition) so every live-only field is
   * zeroed/defaulted rather than guessed. `connectedSince: Date.now()`
   * keeps the downstream `uptime = Date.now() - connectedSince` topology
   * projection at ~0 instead of asserting a stale/undefined value.
   */
  private buildOfflineEntry(node: { id: string; hostname?: string | null }): AgentListItem {
    return {
      info: {
        id: node.id,
        name: node.id,
        hostname: node.hostname ?? node.id,
        capabilities: [],
        platform: 'unknown',
        arch: 'unknown',
        cpuCores: 0,
        memoryMB: 0,
      },
      localIps: [],
      status: {
        activeCameras: 0,
        cpuPercent: 0,
        memoryPercent: null,
        fps: {},
        errors: [],
      },
      connectedSince: Date.now(),
      isHub: false,
      isOnline: false,
      subProcesses: [],
      agentAddons: [],
    }
  }

  private async buildHubEntry(subProcesses: readonly unknown[] = []): Promise<AgentListItem> {
    const cpus = os.cpus()

    // Get live metrics from the metrics-provider capability (NativeMetricsProvider).
    // The cap contract only exposes async snapshots; the cached read is cheap
    // because the addon's background sampler keeps the snapshot warm.
    let cpuPercent = 0
    let memoryPercent: number | null = null
    const registry = this.capabilityService.getRegistry()
    if (registry) {
      const metricsProvider = registry.getSingleton<IMetricsProvider>('metrics-provider')
      if (metricsProvider) {
        const snapshot = await metricsProvider.getCached()
        if (snapshot) {
          cpuPercent = snapshot.cpu.total
          memoryPercent = snapshot.memory.percent
        }
      }
    }

    return {
      info: {
        id: 'hub',
        name: 'Hub',
        hostname: os.hostname(),
        capabilities: [],
        platform: os.platform(),
        arch: os.arch(),
        cpuCores: cpus.length,
        memoryMB: Math.round(os.totalmem() / 1024 / 1024),
        cpuModel: cpus[0]?.model,
        pythonRuntimes: localSupportedPythonRuntimes(),
      },
      status: {
        activeCameras: 0,
        cpuPercent,
        memoryPercent,
        processRssBytes: process.memoryUsage().rss,
        fps: {},
        errors: [],
      },
      connectedSince: this.bootTimestamp,
      isHub: true,
      subProcesses,
    }
  }

  // ---- Role assignments ----

  getAssignments(cameraId?: number): CameraRoleAssignment[] {
    const all = [...this.assignments.values()]
    if (cameraId !== undefined) return all.filter((a) => a.cameraId === cameraId)
    return all
  }

  setAssignment(assignment: CameraRoleAssignment): void {
    const key = `${assignment.cameraId}:${assignment.role}`
    this.assignments.set(key, { ...assignment })
  }

  removeAssignment(cameraId: number, role: AgentCapability): void {
    const key = `${cameraId}:${role}`
    this.assignments.delete(key)
  }

  activateBackup(cameraId: number, role: AgentCapability): void {
    const primaryKey = `${cameraId}:${role}`
    const primary = this.assignments.get(primaryKey)

    const backup = [...this.assignments.values()].find(
      (a) => a.cameraId === cameraId && a.role === role && a.priority === 'backup',
    )

    if (!backup) return

    if (primary) {
      this.assignments.delete(primaryKey)
    }

    const promoted: CameraRoleAssignment = { ...backup, priority: 'primary' }
    this.assignments.set(primaryKey, promoted)

    this.eventBus.emit({
      id: randomUUID(),
      timestamp: new Date(),
      source: { type: 'core', id: 'agent-registry' },
      category: EventCategory.AgentBackupActivated,
      data: { cameraId, role, agentId: promoted.agentId },
    })
  }
}
