import { errMsg, type IScopedLogger } from '@camstack/types'
import {
  type CommissionResult,
  type MatterAttributeReport,
  type MatterCommandInvocation,
  type MatterController,
  type MatterControllerOptions,
  type MatterNodeSnapshot,
  type Unsubscribe,
} from './matter-controller.js'
import { MatterJsController } from './matter-controller-impl.js'
import { matterNodes } from './matter-gateway.js'
import type { MatterConnection } from './config.js'

/** Status of a single Matter fabric connection. */
export type MatterBrokerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Immutable snapshot returned by {@link MatterIntegrationManager.getInfo}. */
export interface MatterBrokerInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'matter'
  readonly status: MatterBrokerStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

/** Factory seam: build a controller (tests inject a fake; default = matter.js stub). */
export type MatterControllerFactory = (options: MatterControllerOptions) => MatterController

/** Constructor options for {@link MatterIntegrationManager}. */
export interface MatterIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: MatterConnection
  readonly dataDir: string
  readonly logger: IScopedLogger
  readonly onConnected: (brokerId: string) => void
  readonly onDisconnected: (brokerId: string) => void
  /** Fired when the commissioned-node set changes (PULL reconcile). */
  readonly onNodesChanged: (brokerId: string, nodes: readonly MatterNodeSnapshot[]) => void
  /** Fired on every attribute report so the addon can fan it to children. */
  readonly onAttributeReport: (brokerId: string, report: MatterAttributeReport) => void
  /** Factory seam for testing. */
  readonly makeController?: MatterControllerFactory
}

/**
 * Wraps exactly one {@link MatterController} (= one fabric). Boots the controller
 * on `start()`, subscribes to attribute reports, runs a periodic PULL reconcile
 * of the node inventory, and publishes the live snapshot on the shared
 * {@link matterNodes} resolver so device classes read live state.
 *
 * Mirrors the Ecowitt / Dreame integration manager. `onShutdown` closes the
 * controller FIRST (the stream-broker discipline: a graceful respawn must not
 * leak the controller's OS sockets / subscriptions) — implemented in `stop()`.
 */
export class MatterIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: MatterConnection
  readonly #dataDir: string
  readonly #logger: IScopedLogger
  readonly #onConnected: (brokerId: string) => void
  readonly #onDisconnected: (brokerId: string) => void
  readonly #onNodesChanged: (brokerId: string, nodes: readonly MatterNodeSnapshot[]) => void
  readonly #onAttributeReport: (brokerId: string, report: MatterAttributeReport) => void
  readonly #makeController: MatterControllerFactory

  #controller: MatterController | null = null
  #reportUnsub: Unsubscribe | null = null
  #reconcileTimer: ReturnType<typeof setInterval> | null = null
  #status: MatterBrokerStatus = 'disconnected'
  #nodeCount = 0
  #lastCheckedAt: number | null = null
  #error: string | null = null

  constructor(options: MatterIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#dataDir = options.dataDir
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onNodesChanged = options.onNodesChanged
    this.#onAttributeReport = options.onAttributeReport
    this.#makeController =
      options.makeController ?? ((opts) => new MatterJsController(opts, this.#logger))
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): MatterConnection {
    return this.#connection
  }

  /** Immutable snapshot of current manager state. */
  getInfo(): MatterBrokerInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'matter',
      status: this.#status,
      info: { nodeCount: this.#nodeCount },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  /** Commission a node, then reconcile the inventory. */
  async commissionNode(pairingCode: string): Promise<CommissionResult> {
    const result = await this.requireController().commissionNode(pairingCode)
    await this.reconcile()
    return result
  }

  /** Remove (decommission) a node, then reconcile. */
  async removeNode(nodeId: string): Promise<void> {
    await this.requireController().removeNode(nodeId)
    await this.reconcile()
  }

  /** Invoke an outbound cluster command on the live controller. */
  async invokeCommand(invocation: MatterCommandInvocation): Promise<void> {
    await this.requireController().invokeCommand(invocation)
  }

  /** Boot the controller, subscribe to reports, seed + schedule reconcile. */
  async start(): Promise<void> {
    if (this.#controller !== null) {
      this.#logger.warn('MatterIntegrationManager: start() called while running — stop first', {
        tags: { brokerId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null

    const controller = this.#makeController({ dataDir: this.#dataDir, brokerId: this.#id })
    this.#controller = controller

    this.#reportUnsub = controller.subscribe((report) => {
      matterNodes.recordAttribute(this.#id, report)
      this.#lastCheckedAt = Date.now()
      this.#onAttributeReport(this.#id, report)
    })

    try {
      await controller.start()
      this.#status = 'connected'
      this.#lastCheckedAt = Date.now()
      this.#onConnected(this.#id)
      await this.reconcile()
      this.#scheduleReconcile()
      this.#logger.info('MatterIntegrationManager: started', { tags: { brokerId: this.#id } })
    } catch (err: unknown) {
      this.#status = 'error'
      this.#error = errMsg(err)
      this.#lastCheckedAt = Date.now()
      this.#logger.warn('MatterIntegrationManager: controller start failed', {
        tags: { brokerId: this.#id },
        meta: { error: errMsg(err) },
      })
    }
  }

  /** PULL the controller's commissioned-node list + publish to the resolver. */
  async reconcile(): Promise<void> {
    const controller = this.#controller
    if (controller === null) return
    try {
      const nodes = await controller.listNodes()
      this.#nodeCount = nodes.length
      this.#lastCheckedAt = Date.now()
      matterNodes.setNodes(this.#id, nodes)
      this.#onNodesChanged(this.#id, nodes)
    } catch (err: unknown) {
      this.#error = errMsg(err)
      this.#logger.warn('MatterIntegrationManager: node reconcile failed', {
        tags: { brokerId: this.#id },
        meta: { error: errMsg(err) },
      })
    }
  }

  /** Stop reconcile timer + subscription, close the controller (FIRST), null it. */
  async stop(): Promise<void> {
    if (this.#reconcileTimer !== null) {
      clearInterval(this.#reconcileTimer)
      this.#reconcileTimer = null
    }
    if (this.#reportUnsub !== null) {
      try {
        this.#reportUnsub()
      } catch {
        // best-effort
      }
      this.#reportUnsub = null
    }
    const controller = this.#controller
    this.#controller = null
    this.#status = 'disconnected'
    if (controller !== null) {
      try {
        await controller.stop()
      } catch (err: unknown) {
        this.#logger.warn('MatterIntegrationManager: controller stop failed', {
          tags: { brokerId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    matterNodes.remove(this.#id)
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, start fresh. */
  async applyConnection(conn: MatterConnection): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }

  #scheduleReconcile(): void {
    if (this.#reconcileTimer !== null) return
    this.#reconcileTimer = setInterval(() => {
      void this.reconcile()
    }, this.#connection.reconcileIntervalMs)
    // Don't keep the runner alive solely for the reconcile poll.
    if (typeof this.#reconcileTimer.unref === 'function') this.#reconcileTimer.unref()
  }

  private requireController(): MatterController {
    if (this.#controller === null) {
      throw new Error(`MatterIntegrationManager: controller unavailable (broker=${this.#id})`)
    }
    return this.#controller
  }
}

/** True when two connections are the "same" (no controller rebuild needed). */
export function sameConnection(a: MatterConnection | null, b: MatterConnection | null): boolean {
  if (a === null || b === null) return false
  return (
    a.threadDataset === b.threadDataset &&
    a.wifiSsid === b.wifiSsid &&
    a.wifiPassword === b.wifiPassword &&
    a.reconcileIntervalMs === b.reconcileIntervalMs
  )
}
