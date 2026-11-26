import type {
  MatterAttributeReport,
  MatterCommandInvocation,
  MatterEventReport,
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

/** One cached attribute: the report and when the gateway recorded it (ms epoch). */
export interface CachedAttribute {
  readonly report: MatterAttributeReport
  readonly recordedAt: number
}

/** A subscriber to live per-broker attribute reports. */
export type AttributeReportListener = (brokerId: string, report: MatterAttributeReport) => void

/** A subscriber to live per-broker Matter events. */
export type EventListener = (brokerId: string, event: MatterEventReport) => void

/** A subscriber to a node's reachability, fired on every inventory publish. */
export type NodePresenceListener = (brokerId: string, nodeId: string, online: boolean) => void

export class MatterNodeResolver {
  /** Latest node inventory per broker. */
  readonly #nodes: Map<string, ReadonlyMap<string, MatterNodeSnapshot>> = new Map()
  /** Latest attribute value per broker → attrKey → value. */
  readonly #attrs: Map<string, Map<string, CachedAttribute>> = new Map()
  /** Live attribute-report subscribers (endpoint device classes). */
  readonly #listeners: Set<AttributeReportListener> = new Set()
  readonly #eventListeners: Set<EventListener> = new Set()
  readonly #presenceListeners: Set<NodePresenceListener> = new Set()
  /** Highest event number seen per `broker:node` — a replayed event is not new. */
  readonly #lastEventNumber: Map<string, number> = new Map()
  /** Adopted container id per Matter node, for subscription logs. */
  readonly #deviceIds: Map<string, number> = new Map()

  /**
   * Subscribe to live attribute reports across all brokers. Endpoint device
   * classes subscribe on activate (filtering to their own node/endpoint) so a
   * push report decodes straight into their runtime-state slice. Returns a
   * disposer.
   */
  /** Remember the CamStack container id for a commissioned node. */
  bindDevice(nodeId: string, deviceId: number): void {
    this.#deviceIds.set(nodeId, deviceId)
  }

  unbindDevice(nodeId: string): void {
    this.#deviceIds.delete(nodeId)
  }

  deviceIdFor(nodeId: string): number | null {
    return this.#deviceIds.get(nodeId) ?? null
  }

  /** Subscribe to Matter events (lock operations, switch presses). Returns a disposer. */
  onEvent(listener: EventListener): () => void {
    this.#eventListeners.add(listener)
    return () => {
      this.#eventListeners.delete(listener)
    }
  }

  /** Subscribe to node reachability. Returns a disposer. */
  onNodePresence(listener: NodePresenceListener): () => void {
    this.#presenceListeners.add(listener)
    return () => {
      this.#presenceListeners.delete(listener)
    }
  }

  /**
   * Fan one Matter event to its subscribers. Returns false (and delivers
   * nothing) when the node already delivered an event with this number or a
   * higher one — a resubscribe re-reads the node's buffered events, and a
   * replayed `unlocked` must not look like somebody unlocking the door now.
   */
  recordEvent(brokerId: string, event: MatterEventReport): boolean {
    if (event.eventNumber !== null) {
      const key = `${brokerId}:${event.nodeId}`
      const last = this.#lastEventNumber.get(key)
      if (last !== undefined && event.eventNumber <= last) return false
      this.#lastEventNumber.set(key, event.eventNumber)
    }
    for (const listener of this.#eventListeners) {
      try {
        listener(brokerId, event)
      } catch {
        // A faulty subscriber must not break the event path.
      }
    }
    return true
  }

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
    for (const n of nodes) {
      for (const listener of this.#presenceListeners) {
        try {
          listener(brokerId, n.nodeId, n.online)
        } catch {
          // A faulty subscriber must not break the publish path.
        }
      }
    }
  }

  /** Record one attribute report's latest value + fan it to live subscribers. */
  recordAttribute(brokerId: string, report: MatterAttributeReport): void {
    let perBroker = this.#attrs.get(brokerId)
    if (perBroker === undefined) {
      perBroker = new Map<string, CachedAttribute>()
      this.#attrs.set(brokerId, perBroker)
    }
    perBroker.set(attrKey(report), { report, recordedAt: Date.now() })
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
      ?.report.value
  }

  /** Every cached attribute of one node, with the time the gateway recorded each. */
  cachedAttributesOf(brokerId: string, nodeId: string): readonly CachedAttribute[] {
    const perBroker = this.#attrs.get(brokerId)
    if (perBroker === undefined) return []
    return Array.from(perBroker.values()).filter((c) => c.report.nodeId === nodeId)
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
    this.#eventListeners.clear()
    this.#presenceListeners.clear()
    this.#lastEventNumber.clear()
    this.#deviceIds.clear()
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
