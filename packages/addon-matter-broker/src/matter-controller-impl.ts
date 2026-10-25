/**
 * Real {@link MatterController} backed by matter.js v0.17 (`@matter/main` +
 * `@matter/nodejs`).
 *
 * matter.js v0.17 uses the "node API": a {@link ServerNode} owns the controller
 * fabric, and commissioned devices are {@link ClientNode} peers reachable via
 * `serverNode.peers`. This class wraps exactly one `ServerNode` per broker
 * (= one fabric), persisting it under the addon `dataDir` via the matter.js
 * `Environment`'s `storage.path` variable.
 *
 * Bound API (matter.js 0.17.3):
 *   - `ServerNode.create({ environment, id })` — fabric owner; storage at dataDir.
 *   - `serverNode.peers.commission({ pairingCode })` — commission a node from a
 *     QR (`MT:…`) or manual pairing code; resolves to a `ClientNode`.
 *   - `serverNode.peers` — iterable of commissioned `ClientNode`s.
 *   - `clientNode.lifecycle.isOnline`, `clientNode.peerAddress.nodeId` — liveness
 *     + stable node id.
 *   - `clientNode.decommission()` — remove a node from the fabric.
 *   - endpoint `commandsOf(behaviorId)[name](args)` — outbound cluster commands.
 *
 * The dynamic endpoint/cluster/attribute introspection lives in
 * `matter-endpoint-introspect.ts` (the single matter.js dynamic-shape boundary).
 * This class polls each node's endpoint state on reconcile + emits decoded
 * attribute reports, and re-emits on node online/offline transitions.
 *
 * BLE commissioning (`@matter/nodejs-ble`) is NOT wired — that package is not
 * installed. IP / on-network commissioning is the supported path; see the class
 * `commissionNode` note.
 */

import { Environment, ServerNode } from '@matter/main'
import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  MatterControllerNotWiredError,
  type CommissionResult,
  type MatterAttributeReport,
  type MatterCommandInvocation,
  type MatterController,
  type MatterControllerOptions,
  type MatterEndpointSnapshot,
  type MatterNodeSnapshot,
  type Unsubscribe,
} from './matter-controller.js'
import { readNodeEndpoints, invokeNodeCommand } from './matter-endpoint-introspect.js'

/** A commissioning failure (bad code / device unreachable), distinct from runtime. */
export class MatterCommissioningError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`matter-broker: commissioning failed — ${message}`, options)
    this.name = 'MatterCommissioningError'
  }
}

/** The minimal dynamic surface we read off a commissioned peer node. */
interface PeerNodeView {
  readonly id: string
  readonly online: boolean
  readonly label: string
  readonly rootEndpoint: unknown
}

/** True when `value` is a non-null object (cast-free record narrowing). */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Real matter.js-backed controller. One instance == one fabric (one broker).
 */
export class MatterJsController implements MatterController {
  readonly #options: MatterControllerOptions
  readonly #logger: IScopedLogger
  readonly #handlers: Set<(report: MatterAttributeReport) => void> = new Set()

  #server: ServerNode | null = null
  /** Last emitted value per `node:endpoint:cluster:attribute` (change detection). */
  readonly #lastValues: Map<string, unknown> = new Map()

  constructor(options: MatterControllerOptions, logger: IScopedLogger) {
    this.#options = options
    this.#logger = logger
  }

  get options(): MatterControllerOptions {
    return this.#options
  }

  /** Boot the ServerNode fabric, loading/persisting state from `dataDir`. */
  async start(): Promise<void> {
    if (this.#server !== null) return
    const environment = this.#buildEnvironment()
    const server = await ServerNode.create({
      environment,
      id: this.#options.brokerId,
    })
    this.#server = server
    await server.start()
    this.#logger.info('MatterJsController: ServerNode online', {
      tags: { brokerId: this.#options.brokerId },
    })
    // Seed reports from whatever peers already persisted on the fabric.
    this.#emitAllReports()
  }

  /** Close the ServerNode FIRST (frees OS sockets/subscriptions), then clear. */
  async stop(): Promise<void> {
    this.#handlers.clear()
    const server = this.#server
    this.#server = null
    this.#lastValues.clear()
    if (server === null) return
    try {
      await server.close()
    } catch (err: unknown) {
      this.#logger.warn('MatterJsController: ServerNode close failed', {
        tags: { brokerId: this.#options.brokerId },
        meta: { error: errMsg(err) },
      })
    }
  }

  /**
   * Commission a node from a QR (`MT:…`) or manual pairing code. matter.js
   * decodes either form internally; the addon validated the shape upstream.
   * IP / on-network commissioning only — BLE is not wired (see file header).
   */
  async commissionNode(pairingCode: string): Promise<CommissionResult> {
    const server = this.#requireServer('commissionNode')
    try {
      const node = await server.peers.commission({ pairingCode })
      const view = this.#viewPeer(node)
      this.#logger.info('MatterJsController: node commissioned', {
        tags: { brokerId: this.#options.brokerId },
        meta: { nodeId: view?.id ?? '(unknown)' },
      })
      this.#emitAllReports()
      if (view === null) {
        throw new MatterCommissioningError('commissioned node exposed no operational id')
      }
      return { nodeId: view.id }
    } catch (err: unknown) {
      if (err instanceof MatterCommissioningError) throw err
      throw new MatterCommissioningError(errMsg(err), { cause: err })
    }
  }

  /** Pull the live commissioned-node inventory off `serverNode.peers`. */
  async listNodes(): Promise<readonly MatterNodeSnapshot[]> {
    const server = this.#server
    if (server === null) return []
    const out: MatterNodeSnapshot[] = []
    for (const peer of this.#peers(server)) {
      const snapshot = this.#snapshot(peer)
      if (snapshot !== null) out.push(snapshot)
    }
    return out
  }

  async getNode(nodeId: string): Promise<MatterNodeSnapshot | null> {
    const nodes = await this.listNodes()
    return nodes.find((n) => n.nodeId === nodeId) ?? null
  }

  subscribe(handler: (report: MatterAttributeReport) => void): Unsubscribe {
    this.#handlers.add(handler)
    return () => {
      this.#handlers.delete(handler)
    }
  }

  /** Invoke an outbound cluster command on a commissioned node's endpoint. */
  async invokeCommand(invocation: MatterCommandInvocation): Promise<void> {
    const server = this.#requireServer('invokeCommand')
    const peer = this.#findPeer(server, invocation.nodeId)
    if (peer === null) {
      throw new Error(`matter-broker: node ${invocation.nodeId} not commissioned`)
    }
    await invokeNodeCommand({
      rootEndpoint: peer.rootEndpoint,
      endpointId: invocation.endpointId,
      clusterId: invocation.clusterId,
      commandName: invocation.commandName,
      ...(invocation.args !== undefined ? { args: invocation.args } : {}),
    })
  }

  /** Decommission a node from this fabric (best-effort device round-trip). */
  async removeNode(nodeId: string): Promise<void> {
    const server = this.#requireServer('removeNode')
    const node = this.#rawPeer(server, nodeId)
    if (node === null) return
    try {
      await this.#decommission(node)
    } catch (err: unknown) {
      this.#logger.warn('MatterJsController: decommission failed', {
        tags: { brokerId: this.#options.brokerId },
        meta: { nodeId, error: errMsg(err) },
      })
      throw err
    }
  }

  // ── internals ────────────────────────────────────────────────────────────

  #buildEnvironment(): Environment {
    // `@matter/main` configures `Environment.default` with the Node.js platform
    // (filesystem/network/storage) on import. Point storage at the addon dataDir
    // and disable matter.js's process-signal handling (the addon runner owns the
    // process lifecycle — matter.js must not install SIGINT/SIGUSR2 handlers).
    const env = Environment.default
    env.vars.set('storage.path', this.#options.dataDir)
    env.vars.set('runtime.signals', false)
    env.vars.set('runtime.exitcode', false)
    return env
  }

  #requireServer(op: string): ServerNode {
    if (this.#server === null) throw new MatterControllerNotWiredError(op)
    return this.#server
  }

  /** Iterate the commissioned peers of a ServerNode (cast-free). */
  #peers(server: ServerNode): Iterable<unknown> {
    const peers: unknown = server.peers
    if (isIterable(peers)) return peers
    return []
  }

  #findPeer(server: ServerNode, nodeId: string): PeerNodeView | null {
    for (const peer of this.#peers(server)) {
      const view = this.#viewPeer(peer)
      if (view !== null && view.id === nodeId) return view
    }
    return null
  }

  /** Raw (un-viewed) peer object for operations that call its methods. */
  #rawPeer(server: ServerNode, nodeId: string): unknown {
    for (const peer of this.#peers(server)) {
      const view = this.#viewPeer(peer)
      if (view !== null && view.id === nodeId) return peer
    }
    return null
  }

  /** Reduce a peer to the read-only view the addon models. */
  #viewPeer(peer: unknown): PeerNodeView | null {
    if (!isRecord(peer)) return null
    const id = peerNodeId(peer)
    if (id === null) return null
    return {
      id,
      online: peerOnline(peer),
      label: peerLabel(peer) ?? `Matter node ${id}`,
      rootEndpoint: peer,
    }
  }

  /** Build a controller-agnostic snapshot of a peer's endpoints + clusters. */
  #snapshot(peer: unknown): MatterNodeSnapshot | null {
    const view = this.#viewPeer(peer)
    if (view === null) return null
    const endpoints: MatterEndpointSnapshot[] = readNodeEndpoints(view.rootEndpoint).map((ep) => ({
      endpointId: ep.number,
      clusterIds: ep.clusterIds,
    }))
    return { nodeId: view.id, label: view.label, online: view.online, endpoints }
  }

  /** Decommission via the peer's own method (name stable across 0.17.x). */
  async #decommission(peer: unknown): Promise<void> {
    if (!isRecord(peer)) return
    const fn = peer['decommission']
    if (typeof fn !== 'function') {
      // Fallback: force-remove locally if the device round-trip isn't available.
      const del = peer['delete']
      if (typeof del !== 'function') return
      await Promise.resolve(Reflect.apply(del, peer, []))
      return
    }
    await Promise.resolve(Reflect.apply(fn, peer, []))
  }

  /** Read every peer's recognised attributes + emit changed ones as reports. */
  #emitAllReports(): void {
    const server = this.#server
    if (server === null) return
    for (const peer of this.#peers(server)) {
      const view = this.#viewPeer(peer)
      if (view === null) continue
      for (const ep of readNodeEndpoints(view.rootEndpoint)) {
        for (const attr of ep.attributes) {
          const report: MatterAttributeReport = {
            nodeId: view.id,
            endpointId: ep.number,
            clusterId: attr.clusterId,
            attributeId: attr.attributeId,
            value: attr.value,
          }
          this.#emitIfChanged(report)
        }
      }
    }
  }

  #emitIfChanged(report: MatterAttributeReport): void {
    const key = `${report.nodeId}:${report.endpointId}:${report.clusterId}:${report.attributeId}`
    const prev = this.#lastValues.get(key)
    if (prev !== undefined && shallowEqual(prev, report.value)) return
    this.#lastValues.set(key, report.value)
    for (const handler of this.#handlers) {
      try {
        handler(report)
      } catch (err: unknown) {
        this.#logger.warn('MatterJsController: report handler threw', {
          meta: { error: errMsg(err) },
        })
      }
    }
  }
}

/** True when `value` is iterable. */
function isIterable(value: unknown): value is Iterable<unknown> {
  return isRecord(value) && typeof Reflect.get(value, Symbol.iterator) === 'function'
}

/** Cheap equality for primitive attribute values (objects always re-emit). */
function shallowEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (typeof a === 'object') return false
  return false
}

/** Read a stable operational node id off a peer (`peerAddress.nodeId`/`id`). */
function peerNodeId(peer: Record<string, unknown>): string | null {
  const addr = peer['peerAddress']
  if (isRecord(addr)) {
    const nodeId = addr['nodeId']
    if (typeof nodeId === 'number' || typeof nodeId === 'bigint') return String(nodeId)
    if (typeof nodeId === 'string' && nodeId.length > 0) return nodeId
  }
  const id = peer['id']
  if (typeof id === 'string' && id.length > 0) return id
  return null
}

/** Liveness from the peer's `lifecycle.isOnline`. */
function peerOnline(peer: Record<string, unknown>): boolean {
  const lifecycle = peer['lifecycle']
  if (isRecord(lifecycle)) {
    const online = lifecycle['isOnline']
    if (typeof online === 'boolean') return online
  }
  return false
}

/** Best-effort human label from BasicInformation state, else null. */
function peerLabel(peer: Record<string, unknown>): string | null {
  const stateOf = peer['stateOf']
  if (typeof stateOf !== 'function') return null
  let basic: unknown
  try {
    basic = Reflect.apply(stateOf, peer, ['basicInformation'])
  } catch {
    return null
  }
  if (!isRecord(basic)) return null
  const product = basic['productName']
  const vendor = basic['vendorName']
  const node = basic['nodeLabel']
  const parts = [vendor, product, node].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  )
  return parts.length > 0 ? parts.join(' ') : null
}
