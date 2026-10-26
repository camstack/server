/**
 * Real {@link MatterController} backed by matter.js (`@matter/main` +
 * `@matter/nodejs`). ServerNode / ClientNode is the API this controller uses.
 *
 * One `ServerNode` per broker (= one fabric). Storage is matter.js's own
 * files under the addon `dataDir` (`Environment` `storage.path`) — the
 * library-owned exception for fabric root / NOC / node registry, same class
 * as HAP pairing files. Not the keychain.
 *
 * Bound API:
 *   - `ServerNode.create({ environment, id })` — fabric owner.
 *   - `serverNode.peers.commission({ pairingCode, continueCommissioningAfterPase })`.
 *   - `clientNode.interaction.subscribe({ sustain: true })` — attribute reports.
 *   - `clientNode.lifecycle` online / offline — resubscribe.
 *   - endpoint `commandsOf(behaviorId)[name](args)` — outbound commands.
 *
 * BLE commissioning is not wired. IP / on-network share codes only.
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
import {
  classifyCommissionError,
  commissionFailureMessage,
  type CommissionProgress,
  CommissionPhase,
} from './matter-commission-progress.js'
import { subscribableFromPeer } from './matter-peer-subscribe.js'
import { MatterSubscriptionSupervisor, type MatterSubscribablePeer } from './matter-subscription.js'

/** A commissioning failure (bad code / device unreachable), distinct from runtime. */
export class MatterCommissioningError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(`matter-broker: commissioning failed — ${message}`, options)
    this.name = 'MatterCommissioningError'
  }
}

/** Fabric handle. Production wraps `ServerNode`; tests pass a recorded peer. */
export interface MatterFabricServer {
  start(): Promise<void>
  close(): Promise<void>
  listPeers(): Iterable<unknown>
  commission(input: { readonly pairingCode: string; readonly onPase: () => void }): Promise<unknown>
}

export interface MatterJsControllerOptions extends MatterControllerOptions {
  /** Test seam. Production builds a `ServerNode` when this is omitted. */
  readonly openServer?: () => Promise<MatterFabricServer>
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
  readonly #options: MatterJsControllerOptions
  readonly #logger: IScopedLogger
  readonly #handlers: Set<(report: MatterAttributeReport) => void> = new Set()
  readonly #subscriptions: MatterSubscriptionSupervisor

  #server: MatterFabricServer | null = null
  /** Last emitted value per `node:endpoint:cluster:attribute` (change detection). */
  readonly #lastValues: Map<string, unknown> = new Map()

  constructor(options: MatterJsControllerOptions, logger: IScopedLogger) {
    this.#options = options
    this.#logger = logger
    this.#subscriptions = new MatterSubscriptionSupervisor({
      brokerId: options.brokerId,
      logger,
      resolveDeviceId: options.resolveDeviceId ?? (() => null),
      onReport: (report) => this.#emitIfChanged(report),
    })
  }

  get options(): MatterControllerOptions {
    return this.#options
  }

  /** Boot the ServerNode fabric, loading/persisting state from `dataDir`. */
  async start(): Promise<void> {
    if (this.#server !== null) return
    const server =
      this.#options.openServer !== undefined
        ? await this.#options.openServer()
        : await this.#openProductionServer()
    this.#server = server
    await server.start()
    this.#logger.info('MatterJsController: ServerNode online', {
      tags: { brokerId: this.#options.brokerId },
    })
    await this.syncSubscriptions()
    // Seed from cached attribute state in case the subscription's first report
    // is still in flight. Missing values are not emitted.
    this.#emitAllReports()
  }

  /** Close subscriptions FIRST, then the ServerNode. */
  async stop(): Promise<void> {
    this.#handlers.clear()
    await this.#subscriptions.stop()
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
    this.#progress({ phase: CommissionPhase.Discovering, failure: null, message: null })
    try {
      const node = await server.commission({
        pairingCode,
        onPase: () => {
          this.#progress({ phase: CommissionPhase.Pase, failure: null, message: null })
          this.#progress({ phase: CommissionPhase.Commissioning, failure: null, message: null })
        },
      })
      const view = this.#viewPeer(node)
      this.#logger.info('MatterJsController: node commissioned', {
        tags: { brokerId: this.#options.brokerId },
        meta: { nodeId: view?.id ?? '(unknown)' },
      })
      await this.syncSubscriptions()
      this.#emitAllReports()
      if (view === null) {
        throw new MatterCommissioningError('commissioned node exposed no operational id')
      }
      this.#progress({ phase: CommissionPhase.Done, failure: null, message: null })
      return { nodeId: view.id }
    } catch (err: unknown) {
      if (err instanceof MatterCommissioningError && err.message.includes('no operational id')) {
        this.#failCommission(err.message)
        throw err
      }
      const message = errMsg(err)
      this.#failCommission(message)
      throw new MatterCommissioningError(
        commissionFailureMessage(classifyCommissionError(message), message),
        {
          cause: err,
        },
      )
    }
  }

  /** Pull the live commissioned-node inventory off `serverNode.peers`. */
  async listNodes(): Promise<readonly MatterNodeSnapshot[]> {
    const server = this.#server
    if (server === null) return []
    const out: MatterNodeSnapshot[] = []
    for (const peer of server.listPeers()) {
      const snapshot = this.#snapshot(peer)
      if (snapshot !== null) out.push(snapshot)
    }
    return out
  }

  async syncSubscriptions(): Promise<void> {
    const server = this.#server
    if (server === null) return
    const peers: MatterSubscribablePeer[] = []
    for (const peer of server.listPeers()) {
      const view = this.#viewPeer(peer)
      if (view === null) continue
      const subscribable = subscribableFromPeer(peer, view.id)
      if (subscribable === null) {
        this.#logger.warn('MatterJsController: peer has no attribute subscription', {
          tags: { brokerId: this.#options.brokerId },
          meta: { nodeId: view.id },
        })
        continue
      }
      peers.push(subscribable)
    }
    await this.#subscriptions.sync(peers)
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

  async #openProductionServer(): Promise<MatterFabricServer> {
    const environment = this.#buildEnvironment()
    const server = await ServerNode.create({
      environment,
      id: this.#options.brokerId,
    })
    return {
      start: () => server.start(),
      close: () => server.close(),
      listPeers: () => this.#serverPeers(server),
      commission: ({ pairingCode, onPase }) =>
        server.peers.commission({
          pairingCode,
          continueCommissioningAfterPase: () => {
            onPase()
            return true
          },
        }),
    }
  }

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

  #requireServer(op: string): MatterFabricServer {
    if (this.#server === null) throw new MatterControllerNotWiredError(op)
    return this.#server
  }

  /** Iterate the commissioned peers of a ServerNode (cast-free). */
  #serverPeers(server: ServerNode): Iterable<unknown> {
    const peers: unknown = server.peers
    if (isIterable(peers)) return peers
    return []
  }

  #findPeer(server: MatterFabricServer, nodeId: string): PeerNodeView | null {
    for (const peer of server.listPeers()) {
      const view = this.#viewPeer(peer)
      if (view !== null && view.id === nodeId) return view
    }
    return null
  }

  /** Raw (un-viewed) peer object for operations that call its methods. */
  #rawPeer(server: MatterFabricServer, nodeId: string): unknown {
    for (const peer of server.listPeers()) {
      const view = this.#viewPeer(peer)
      if (view !== null && view.id === nodeId) return peer
    }
    return null
  }

  #progress(progress: CommissionProgress): void {
    this.#options.onCommissionProgress?.(progress)
  }

  #failCommission(message: string): void {
    const failure = classifyCommissionError(message)
    this.#progress({
      phase: CommissionPhase.Failed,
      failure,
      message: commissionFailureMessage(failure, message),
    })
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
    for (const peer of server.listPeers()) {
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
    if (report.value === undefined || report.value === null) return
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
