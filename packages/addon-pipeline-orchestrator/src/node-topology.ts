/**
 * `NodeTopologyService` — node topology & eligibility (C4, S6 extraction).
 *
 * Owns `knownRunnerNodes`, the four `enabled*` allow-lists, `remoteSourcingNodes`,
 * `reachableHostByNode`, and `clusterRoles` — extracted verbatim (mechanical,
 * zero logic change) from `index.ts`. Every method here already delegated its
 * math to the existing pure modules (`frame-source-eligibility.ts` /
 * `source-owner.ts` / `ingest-owner.ts`); this class just re-homes the state
 * + the methods that read/derive it.
 *
 * `collectAudioNodeIds` is a thin alias of the shared `collectHubPlusKnown`
 * (its former byte-identical twin `collectDecoderNodeIds` was removed with
 * the per-camera 'Decoder Node' select — decode co-locates with detection).
 */
import type { IEventBus, IngestOwner, IScopedLogger } from '@camstack/types'
import { createEvent, errMsg, EventCategory } from '@camstack/types'
import { eligibleUnderBenchmark } from '@camstack/types'
import { computeFrameSourceNodes } from './frame-source-eligibility.js'
import { resolveIngestOwner } from './ingest-owner.js'
import { deriveRemoteSourcingNodes, resolveSourceOwner } from './source-owner.js'
import type { AgentSettingsMapBlob } from './orchestrator-store-schemas.js'
import type { ClusterRoles } from './orchestrator-types.js'

export interface NodeTopologyServiceDeps {
  /** Reads the persisted per-node capability store (`PipelineSettingsStore.readAgentSettingsMap`). */
  readonly readAgentSettingsMap: () => Promise<AgentSettingsMapBlob>
  readonly eventBus: IEventBus
  readonly logger: IScopedLogger
  /** This node's Moleculer nodeId, resolved live (not snapshotted at construction). */
  readonly localNodeId: () => string
  /** The addon's own id — used as the `PipelineIngestOwnerChanged` event source. */
  readonly addonId: () => string
  /**
   * The node the cluster is in benchmark mode for (D791), null when none. It
   * is not a detection candidate for a camera another node can serve. Absent
   * = never (tests that do not model the benchmark).
   */
  readonly benchmarkNodeId?: () => string | null
}

/**
 * Default placement capability for a node when its stored flag is unset:
 * the hub is capable of every role out of the box; every other node must be
 * explicitly enabled.
 */
function nodeCapabilityDefault(nodeId: string): boolean {
  return nodeId === 'hub'
}

export class NodeTopologyService {
  /** Set of nodeIds known to be running pipeline-runner; maintained via AgentOnline/AgentOffline events. */
  private readonly knownRunnerNodes = new Set<string>(['hub'])
  private _enabledNodes: readonly string[] = ['hub']
  private _enabledDecoderNodes: readonly string[] = ['hub']
  private _enabledAudioNodes: readonly string[] = ['hub']
  private _enabledIngestNodes: readonly string[] = ['hub']
  private _remoteSourcingNodes: readonly string[] = []
  private _reachableHostByNode: ReadonlyMap<string, string> = new Map()
  private _clusterRoles: ClusterRoles = {
    ingestNode: 'hub',
    audioNode: 'hub',
    motionNode: 'hub',
  }

  constructor(private readonly deps: NodeTopologyServiceDeps) {}

  // ── Known runner nodes ───────────────────────────────────────────────

  knownRunnerNodeIds(): readonly string[] {
    return [...this.knownRunnerNodes]
  }

  addKnownRunnerNode(nodeId: string): void {
    this.knownRunnerNodes.add(nodeId)
  }

  removeKnownRunnerNode(nodeId: string): void {
    this.knownRunnerNodes.delete(nodeId)
  }

  clearKnownRunnerNodes(): void {
    this.knownRunnerNodes.clear()
  }

  /**
   * Enumerate every runner-capable node currently known. Forked child
   * nodeIds (`hub/classifier`) are filtered out — they name isolated-process
   * services, never dispatchable pipeline runners.
   */
  collectRunnerNodeIds(): readonly string[] {
    return [...this.knownRunnerNodes].filter((id) => !id.includes('/')).toSorted()
  }

  /** Shared body for `collectAudioNodeIds` (kept separate for future twins). */
  private collectHubPlusKnown(): string[] {
    const nodeIds = new Set<string>(['hub'])
    for (const nodeId of this.knownRunnerNodes) {
      if (!nodeId.includes('/')) nodeIds.add(nodeId)
    }
    return [...nodeIds].toSorted()
  }

  collectAudioNodeIds(): string[] {
    return this.collectHubPlusKnown()
  }

  // ── Enabled-node allow-lists + cluster roles (read accessors) ────────

  get enabledNodes(): readonly string[] {
    return this._enabledNodes
  }

  /**
   * Node ids eligible to host decode sessions. IDENTICAL to
   * {@link enabledNodes} by construction (detect ⇒ decode): decode is always
   * co-located with its frame consumer, so the separate per-node decode flag
   * was removed. Kept as a distinct accessor only because the frame-source
   * vocabulary (`computeFrameSourceNodes`, `deriveRemoteSourcingNodes`)
   * speaks in decoder-node terms.
   */
  get enabledDecoderNodes(): readonly string[] {
    return this._enabledDecoderNodes
  }

  get enabledAudioNodes(): readonly string[] {
    return this._enabledAudioNodes
  }

  get enabledIngestNodes(): readonly string[] {
    return this._enabledIngestNodes
  }

  get remoteSourcingNodes(): readonly string[] {
    return this._remoteSourcingNodes
  }

  get reachableHostByNode(): ReadonlyMap<string, string> {
    return this._reachableHostByNode
  }

  get clusterRoles(): ClusterRoles {
    return this._clusterRoles
  }

  setClusterRoles(roles: ClusterRoles): void {
    this._clusterRoles = roles
  }

  isNodeEnabled(nodeId: string): boolean {
    return this._enabledNodes.includes(nodeId)
  }

  // ── Source ownership / frame-source eligibility ──────────────────────

  assignSource(_deviceId: number): string {
    return this._clusterRoles.ingestNode
  }

  async getIngestOwner(): Promise<IngestOwner> {
    return resolveIngestOwner(
      this._clusterRoles,
      this._reachableHostByNode,
      this._enabledIngestNodes,
    )
  }

  sourceOwner(deviceId?: number): string | undefined {
    return resolveSourceOwner({
      ownerNodeId: this._clusterRoles.ingestNode,
      remoteSourcingNodes: this._remoteSourcingNodes,
      ...(deviceId !== undefined ? { assignedOwner: this.assignSource(deviceId) } : {}),
    })
  }

  frameSourceNodes(deviceId?: number): readonly string[] {
    return computeFrameSourceNodes({
      enabledDecoderNodes: this._enabledDecoderNodes,
      sourceOwnerNodeId: this.sourceOwner(deviceId),
      remoteSourcingNodes: this._remoteSourcingNodes,
    })
  }

  /**
   * The nodes that may run this camera's detection. While the cluster is in
   * benchmark mode for a node (D791), that node is left out — unless it is
   * the camera's only frame source, in which case the camera stays (never
   * blind) and the run is flagged contaminated.
   */
  detectionEligibleNodes(deviceId?: number): readonly string[] {
    return eligibleUnderBenchmark(
      this.detectionEligibleNodesIgnoringBenchmark(deviceId),
      this.deps.benchmarkNodeId?.() ?? null,
    )
  }

  /** {@link detectionEligibleNodes} as if no benchmark ran — the camera's real candidates. */
  detectionEligibleNodesIgnoringBenchmark(deviceId?: number): readonly string[] {
    const frameSource = this.frameSourceNodes(deviceId)
    return this._enabledNodes.filter((nodeId) => frameSource.includes(nodeId))
  }

  // ── Capability-store-driven derivation ───────────────────────────────

  /**
   * Recompute the derived enabled-node sets from the per-node capability
   * store, then push the resolved camera-source owner to consumers.
   * Extracted verbatim from `index.ts`'s `refreshNodeCapabilities`.
   */
  async refreshNodeCapabilities(): Promise<void> {
    let blob: AgentSettingsMapBlob = {}
    try {
      blob = await this.deps.readAgentSettingsMap()
    } catch (err: unknown) {
      this.deps.logger.warn('refreshNodeCapabilities: agent settings read failed', {
        meta: { error: errMsg(err) },
      })
    }
    const nodeIds = new Set<string>(['hub'])
    for (const nodeId of Object.keys(blob)) {
      if (typeof nodeId === 'string' && nodeId.length > 0 && !nodeId.includes('/')) {
        nodeIds.add(nodeId)
      }
    }
    const detect: string[] = []
    const audio: string[] = []
    const ingest: string[] = []
    const reachableHosts = new Map<string, string>()
    const capable = (flag: boolean | undefined, nodeId: string): boolean =>
      typeof flag === 'boolean' ? flag : nodeCapabilityDefault(nodeId)
    for (const nodeId of nodeIds) {
      const settings = blob[nodeId]
      if (capable(settings?.detect, nodeId)) detect.push(nodeId)
      if (capable(settings?.audio, nodeId)) audio.push(nodeId)
      if (capable(settings?.ingest, nodeId)) ingest.push(nodeId)
      const host = settings?.reachableHost?.trim()
      if (host !== undefined && host.length > 0) reachableHosts.set(nodeId, host)
    }
    this._reachableHostByNode = reachableHosts
    this._enabledNodes = detect.toSorted()
    // Decode is ALWAYS co-located with its frame consumer (the shm ring is
    // node-local; off-owner detection decodes locally via the satellite
    // plane), so decode eligibility IS detect eligibility. The stored legacy
    // `decode` flag is deliberately IGNORED — a detect-enabled node that had
    // decode=false persisted was a silent no-frame-source trap.
    this._enabledDecoderNodes = detect.toSorted()
    this._enabledAudioNodes = audio.toSorted()
    this._enabledIngestNodes = ingest.toSorted()
    // Cross-node ingest (slice 1): every decode-enabled node except the camera
    // OWNER (`clusterRoles.ingestNode`) may run the remote-source leg.
    this._remoteSourcingNodes = deriveRemoteSourcingNodes(
      this._enabledDecoderNodes,
      this._clusterRoles.ingestNode,
    )

    // Push the resolved camera-source owner to consumers (the stream-broker's
    // ingest-owner gate). Emitted on EVERY refresh — boot, agent online/offline,
    // and ingest-node flip — so the broker never has to poll `getIngestOwner` on
    // the per-`ensureBroker` hot path, and a dropped event self-heals on the next
    // topology change. Idempotent: re-emitting the same owner is a harmless no-op
    // for the consumer.
    const { ownerNodeId } = resolveIngestOwner(
      this._clusterRoles,
      this._reachableHostByNode,
      this._enabledIngestNodes,
    )
    this.deps.eventBus.emit(
      createEvent(
        EventCategory.PipelineIngestOwnerChanged,
        { type: 'addon', id: this.deps.addonId(), nodeId: 'hub' },
        { ownerNodeId },
      ),
    )
  }
}
