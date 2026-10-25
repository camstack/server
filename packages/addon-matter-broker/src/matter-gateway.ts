import type {
  MatterAttributeReport,
  MatterCommandInvocation,
  MatterNodeSnapshot,
} from './matter-controller.js'

/**
 * Per-broker in-process resolver device classes use to reach the live Matter
 * node inventory + the latest attribute values for a fabric. Mirrors the
 * Ecowitt / Dreame facade resolver: the integration manager publishes the live
 * snapshot here on each reconcile / attribute report, and device classes read
 * through the resolver so they transparently pick up the live state.
 *
 * The resolver also holds the per-(node,endpoint,cluster,attribute) latest value
 * so a child can seed its slice on activate without waiting for the next push.
 */

/** Key for a single attribute value: `node:endpoint:cluster:attribute`. */
function attrKey(
  report: Pick<MatterAttributeReport, 'nodeId' | 'endpointId' | 'clusterId' | 'attributeId'>,
): string {
  return `${report.nodeId}:${report.endpointId}:${report.clusterId}:${report.attributeId}`
}

/** A subscriber to live per-broker attribute reports. */
export type AttributeReportListener = (brokerId: string, report: MatterAttributeReport) => void

export class MatterNodeResolver {
  /** Latest node inventory per broker. */
  readonly #nodes: Map<string, ReadonlyMap<string, MatterNodeSnapshot>> = new Map()
  /** Latest attribute value per broker → attrKey → value. */
  readonly #attrs: Map<string, Map<string, unknown>> = new Map()
  /** Live attribute-report subscribers (endpoint device classes). */
  readonly #listeners: Set<AttributeReportListener> = new Set()

  /**
   * Subscribe to live attribute reports across all brokers. Endpoint device
   * classes subscribe on activate (filtering to their own node/endpoint) so a
   * push report decodes straight into their runtime-state slice. Returns a
   * disposer.
   */
  onAttributeReport(listener: AttributeReportListener): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  /** Publish (replace) the node inventory for a broker. `null` removes it. */
  setNodes(brokerId: string, nodes: readonly MatterNodeSnapshot[] | null): void {
    if (nodes === null) {
      this.#nodes.delete(brokerId)
      this.#attrs.delete(brokerId)
      return
    }
    const byId = new Map<string, MatterNodeSnapshot>()
    for (const n of nodes) byId.set(n.nodeId, n)
    this.#nodes.set(brokerId, byId)
  }

  /** Record one attribute report's latest value + fan it to live subscribers. */
  recordAttribute(brokerId: string, report: MatterAttributeReport): void {
    let perBroker = this.#attrs.get(brokerId)
    if (perBroker === undefined) {
      perBroker = new Map<string, unknown>()
      this.#attrs.set(brokerId, perBroker)
    }
    perBroker.set(attrKey(report), report.value)
    for (const listener of this.#listeners) {
      try {
        listener(brokerId, report)
      } catch {
        // A faulty subscriber must not break the report path.
      }
    }
  }

  /** All nodes for a broker, or [] when unknown. */
  getNodes(brokerId: string): readonly MatterNodeSnapshot[] {
    const byId = this.#nodes.get(brokerId)
    return byId === undefined ? [] : Array.from(byId.values())
  }

  /** A single node snapshot for a broker, or null. */
  getNode(brokerId: string, nodeId: string): MatterNodeSnapshot | null {
    return this.#nodes.get(brokerId)?.get(nodeId) ?? null
  }

  /** Latest value for a specific attribute, or undefined when never reported. */
  getAttribute(
    brokerId: string,
    nodeId: string,
    endpointId: number,
    clusterId: number,
    attributeId: number,
  ): unknown {
    return this.#attrs.get(brokerId)?.get(attrKey({ nodeId, endpointId, clusterId, attributeId }))
  }

  /** True when the broker has a live (published) inventory. */
  has(brokerId: string): boolean {
    return this.#nodes.has(brokerId)
  }

  /** Remove everything for a broker (on stop/remove). */
  remove(brokerId: string): void {
    this.#nodes.delete(brokerId)
    this.#attrs.delete(brokerId)
  }

  /** Remove all state (full shutdown). */
  clear(): void {
    this.#nodes.clear()
    this.#attrs.clear()
    this.#listeners.clear()
  }
}

/** The single in-process per-broker node resolver shared across the addon. */
export const matterNodes = new MatterNodeResolver()

/**
 * In-process command sink: endpoint device classes invoke outbound cluster
 * commands through this resolver, which the addon wires to each broker's live
 * controller (via the registry). Keeps device classes decoupled from the
 * controller/registry — they only depend on this thin sink. Mirrors the facade
 * resolver pattern used for inbound state.
 */
export class MatterCommandSink {
  #invoke: ((brokerId: string, invocation: MatterCommandInvocation) => Promise<void>) | null = null

  /** Wire the sink to the live command dispatcher (set once by the addon). */
  setDispatcher(
    fn: (brokerId: string, invocation: MatterCommandInvocation) => Promise<void>,
  ): void {
    this.#invoke = fn
  }

  /** Invoke a cluster command for a broker. Throws when no dispatcher is wired. */
  async invoke(brokerId: string, invocation: MatterCommandInvocation): Promise<void> {
    if (this.#invoke === null) {
      throw new Error('matter-broker: command sink has no dispatcher wired')
    }
    await this.#invoke(brokerId, invocation)
  }

  /** Drop the dispatcher (full shutdown). */
  clear(): void {
    this.#invoke = null
  }
}

/** The single in-process command sink shared across the addon. */
export const matterCommands = new MatterCommandSink()
