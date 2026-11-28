/**
 * The `device-mesh` service of the Matter broker: what the fabric's nodes say
 * about the network they sit on, and when that is re-read.
 *
 * Reads come from two places. The wildcard subscription already caches every
 * attribute of every node (battery nodes included), so a topology answer costs
 * no radio traffic. An explicit read goes to the node and refreshes the same
 * cache. Policy (the operator's, 2026-11):
 *   - `refresh` and the periodic timer read MAINS-powered, online nodes only;
 *   - a battery or unknown-power node is never read unasked — its figures are
 *     whatever its subscription delivered, or an explicit `readNow`.
 */

import {
  errMsg,
  type IScopedLogger,
  type MeshNodeDiagnostics,
  type MeshReadNowResult,
  type MeshRefreshResult,
  type MeshTopology,
} from '@dominevo/types'
import type { MatterAttributeReport, MatterReadRequest } from './matter-controller.js'
import { matterNodes, type MatterNodeResolver } from './matter-gateway.js'
import { MatterClusterId } from './matter-cluster-mapping.js'
import { decodeNodeMeshFacts, type MeshAttr, type NodeMeshFacts } from './matter-mesh-decode.js'
import { buildTopology, rloc16Map, type MeshNodeInput } from './matter-mesh-topology.js'

/** Period of the mains-only background refresh. */
export const MESH_REFRESH_INTERVAL_MS = 15 * 60_000

/** The root endpoint carries the node-wide clusters. */
const ROOT_ENDPOINT = 0

/** One `(endpoint, cluster)` wildcard-attribute read. */
export type MeshReadRequest = MatterReadRequest

/** The node-wide clusters a mesh read asks the root endpoint for. */
const ROOT_CLUSTERS: readonly number[] = [
  MatterClusterId.BasicInformation,
  MatterClusterId.GeneralDiagnostics,
  MatterClusterId.ThreadNetworkDiagnostics,
  MatterClusterId.WiFiNetworkDiagnostics,
  MatterClusterId.EthernetNetworkDiagnostics,
  MatterClusterId.OperationalCredentials,
]

/** Reads wildcard attributes of one node through the live controller. */
export type MeshReader = (
  brokerId: string,
  nodeId: string,
  requests: readonly MeshReadRequest[],
) => Promise<readonly MatterAttributeReport[]>

export type MeshNodeSource = Pick<
  MatterNodeResolver,
  'getNodes' | 'getNode' | 'deviceIdFor' | 'cachedAttributesOf' | 'recordAttribute' | 'brokerIds'
>

export class MatterMeshService {
  readonly #nodes: MeshNodeSource
  #logger: IScopedLogger | null = null
  #reader: MeshReader | null = null
  #timer: ReturnType<typeof setInterval> | null = null
  /** When the pass now running started (ms), or `null` when none is in flight. */
  #passStartedAt: number | null = null

  constructor(nodes: MeshNodeSource) {
    this.#nodes = nodes
  }

  /** Wire the addon's logger and the live controller's read path (set once by the addon). */
  attach(logger: IScopedLogger, reader: MeshReader): void {
    this.#logger = logger
    this.#reader = reader
  }

  /** Drop both (addon shutdown): a later read answers "controller not available". */
  detach(): void {
    this.stopPeriodic()
    this.#reader = null
    this.#logger = null
  }

  /** Start the periodic mains pass (one timer; a second call replaces it). */
  startPeriodic(intervalMs: number): void {
    this.stopPeriodic()
    this.#timer = setInterval(() => {
      void this.refreshAll()
    }, intervalMs)
    this.#timer.unref()
  }

  stopPeriodic(): void {
    if (this.#timer !== null) clearInterval(this.#timer)
    this.#timer = null
  }

  topology(brokerId: string): MeshTopology {
    return buildTopology(this.#inputs(brokerId), `matter:${brokerId}`)
  }

  diagnostics(brokerId: string, deviceId: number): MeshNodeDiagnostics {
    const inputs = this.#inputs(brokerId)
    const node = inputs.find((n) => n.deviceId === deviceId)
    if (node === undefined) {
      throw new Error(`device-mesh: device ${deviceId} is not a node of broker ${brokerId}`)
    }
    const { facts } = node
    const rloc16 = rloc16Map(inputs).get(node.nodeId) ?? null
    return {
      deviceId,
      readAt: facts.readAt,
      vendor: facts.vendor,
      product: facts.product,
      hardwareVersion: facts.hardwareVersion,
      softwareVersion: facts.softwareVersion,
      uptimeS: facts.uptimeS,
      rebootCount: facts.rebootCount,
      bootReason: facts.bootReason,
      networkFaults: facts.networkFaults === null ? null : [...facts.networkFaults],
      fabrics: facts.fabrics === null ? null : [...facts.fabrics],
      thread:
        facts.thread === null
          ? null
          : {
              role: facts.thread.role,
              rloc16,
              channel: facts.thread.channel,
              panId: facts.thread.panId,
              extPanId: facts.thread.extPanId,
              partitionId: facts.thread.partitionId,
              neighbors: facts.thread.neighbors === null ? null : [...facts.thread.neighbors],
              routes: facts.thread.routes === null ? null : [...facts.thread.routes],
            },
      wifi: facts.wifi,
      ethernet: facts.ethernet,
    }
  }

  /** Read one node now, whatever its power source: the operator asked. */
  async readNow(brokerId: string, deviceId: number): Promise<MeshReadNowResult> {
    const node = this.#inputs(brokerId).find((n) => n.deviceId === deviceId)
    if (node === undefined) {
      throw new Error(`device-mesh: device ${deviceId} is not a node of broker ${brokerId}`)
    }
    const failure = await this.#read(brokerId, node, true)
    return {
      readOk: failure === null,
      error: failure,
      diagnostics: this.diagnostics(brokerId, deviceId),
    }
  }

  /** Re-read the mains-powered, online nodes of one broker. Never touches any other node. */
  async refresh(brokerId: string): Promise<MeshRefreshResult> {
    let readNodes = 0
    let failedNodes = 0
    let skippedNodes = 0
    for (const node of this.#inputs(brokerId)) {
      if (!node.online || node.facts.power !== 'mains') {
        skippedNodes++
        continue
      }
      const failure = await this.#read(brokerId, node, false)
      if (failure === null) readNodes++
      else failedNodes++
    }
    return { readNodes, failedNodes, skippedNodes }
  }

  /**
   * The periodic pass: every broker, mains nodes only. A tick that finds the
   * previous pass still running is skipped (and logged with that pass's age), so
   * slow, timing-out nodes never stack concurrent passes.
   */
  async refreshAll(): Promise<void> {
    if (this.#passStartedAt !== null) {
      this.#logger?.warn(
        'device-mesh: periodic refresh skipped, the previous pass is still running',
        {
          meta: { inFlightMs: Date.now() - this.#passStartedAt },
        },
      )
      return
    }
    this.#passStartedAt = Date.now()
    try {
      for (const brokerId of this.#nodes.brokerIds()) {
        try {
          const result = await this.refresh(brokerId)
          this.#logger?.debug('device-mesh: periodic refresh', {
            tags: { brokerId },
            meta: { ...result },
          })
        } catch (err: unknown) {
          this.#logger?.warn('device-mesh: periodic refresh failed', {
            tags: { brokerId },
            meta: { error: errMsg(err) },
          })
        }
      }
    } finally {
      this.#passStartedAt = null
    }
  }

  /** `null` on success, else why the read failed. */
  async #read(
    brokerId: string,
    node: MeshNodeInput,
    includePower: boolean,
  ): Promise<string | null> {
    const tags = node.deviceId === null ? { brokerId } : { deviceId: node.deviceId, brokerId }
    const reader = this.#reader
    if (reader === null) {
      this.#logger?.warn('device-mesh: read skipped, the controller is not wired', {
        tags,
        meta: { nodeId: node.nodeId },
      })
      return 'controller not available'
    }
    const requests: MeshReadRequest[] = ROOT_CLUSTERS.map((clusterId) => ({
      endpointId: ROOT_ENDPOINT,
      clusterId,
    }))
    if (includePower) {
      for (const ep of this.#nodes.getNode(brokerId, node.nodeId)?.endpoints ?? []) {
        if (ep.clusterIds.includes(MatterClusterId.PowerSource)) {
          requests.push({
            endpointId: ep.endpointId,
            clusterId: MatterClusterId.PowerSource,
          })
        }
      }
    }
    try {
      const reports = await reader(brokerId, node.nodeId, requests)
      for (const report of reports) this.#nodes.recordAttribute(brokerId, report)
      return null
    } catch (err: unknown) {
      const error = errMsg(err)
      this.#logger?.warn('device-mesh: node read failed', {
        tags,
        meta: { nodeId: node.nodeId, error, requests: requests.length },
      })
      return error
    }
  }

  #inputs(brokerId: string): readonly MeshNodeInput[] {
    return this.#nodes.getNodes(brokerId).map((snapshot) => {
      const attrs: MeshAttr[] = this.#nodes
        .cachedAttributesOf(brokerId, snapshot.nodeId)
        .map((c) => ({
          endpointId: c.report.endpointId,
          clusterId: c.report.clusterId,
          attributeId: c.report.attributeId,
          value: c.report.value,
          recordedAt: c.recordedAt,
        }))
      const facts: NodeMeshFacts = decodeNodeMeshFacts(attrs)
      return {
        nodeId: snapshot.nodeId,
        label: snapshot.label,
        online: snapshot.online,
        deviceId: this.#nodes.deviceIdFor(snapshot.nodeId),
        facts,
      }
    })
  }
}

/** The single in-process mesh service shared across the addon. */
export const matterMesh = new MatterMeshService(matterNodes)
