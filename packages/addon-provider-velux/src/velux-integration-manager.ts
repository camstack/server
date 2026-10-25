import { errMsg, type IScopedLogger } from '@camstack/types'
import type { VeluxConnectionConfig } from './config.js'
import type {
  VeluxGatewayClient,
  VeluxGatewayClientFactory,
  VeluxNode,
} from './velux-client-contract.js'

/** Status of a single Velux gateway connection. */
export type VeluxGatewayStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/**
 * Default client factory — INTENTIONALLY unimplemented. No KLF-200 client
 * library is wired into this addon yet (see `plan-velux.md`). Wiring one is the
 * single remaining step to make Velux live: replace this factory with a real
 * {@link VeluxGatewayClient} implementation. Until then the addon installs and
 * type-checks, but a created gateway stays offline and logs this error.
 */
export const defaultVeluxClientFactory: VeluxGatewayClientFactory = () => {
  throw new Error(
    'velux: no KLF-200 client library is wired yet — implement VeluxGatewayClient ' +
      '(see plan-velux.md) and pass a makeClient factory.',
  )
}

/** Constructor options for {@link VeluxIntegrationManager}. */
export interface VeluxIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: VeluxConnectionConfig
  readonly logger: IScopedLogger
  readonly onConnected: (gatewayId: string) => void
  readonly onDisconnected: (gatewayId: string) => void
  /** Fired after every poll cycle so the gateway device fans the fresh snapshot
   *  out to its cover children. */
  readonly onPolled: (gatewayId: string) => void
  /** Factory seam — defaults to the "not wired" factory above. */
  readonly makeClient?: VeluxGatewayClientFactory
}

/**
 * Wraps exactly one {@link VeluxGatewayClient} (= one KLF-200). The KLF-200 has
 * no push channel via the wrapper we target, so the manager owns a poll loop: on
 * `start()` it connects, lists nodes once, and then periodically re-lists them,
 * firing `onPolled` after every cycle. Mirrors the Rademacher integration
 * manager, with the same fresh-client-on-reconnect discipline.
 */
export class VeluxIntegrationManager {
  readonly #id: string
  #connection: VeluxConnectionConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (gatewayId: string) => void
  readonly #onDisconnected: (gatewayId: string) => void
  readonly #onPolled: (gatewayId: string) => void
  readonly #makeClient: VeluxGatewayClientFactory

  #client: VeluxGatewayClient | null = null
  #nodes: Map<number, VeluxNode> = new Map()
  #status: VeluxGatewayStatus = 'disconnected'
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #error: string | null = null

  constructor(options: VeluxIntegrationManagerOptions) {
    this.#id = options.id
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onPolled = options.onPolled
    this.#makeClient = options.makeClient ?? defaultVeluxClientFactory
  }

  /** The gateway id (= Hub device stableId). */
  get id(): string {
    return this.#id
  }

  /** Current connection status. */
  get status(): VeluxGatewayStatus {
    return this.#status
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): VeluxConnectionConfig {
    return this.#connection
  }

  /** All actuator node handles known to this gateway. */
  getNodes(): readonly VeluxNode[] {
    return [...this.#nodes.values()]
  }

  /** Resolve a single node handle by its node id, or null. */
  getNode(nodeId: number): VeluxNode | null {
    return this.#nodes.get(nodeId) ?? null
  }

  /** The live client, or null when stopped. Cover children drive commands here. */
  get client(): VeluxGatewayClient | null {
    return this.#client
  }

  /**
   * Connect the client, list nodes once, and start the poll loop. A failed
   * connect throws (the caller logs and keeps the device — a later
   * `applyConnection` / restart retries).
   */
  async start(): Promise<void> {
    if (this.#client !== null) {
      this.#logger.warn('VeluxIntegrationManager: start() called while running — stop first', {
        tags: { gatewayId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null

    const client = this.#makeClient({
      host: this.#connection.host,
      password: this.#connection.password,
    })
    this.#client = client

    await client.connect()
    this.#nodes = indexNodes(await client.listNodes())

    this.#status = 'connected'
    this.#onConnected(this.#id)
    this.#onPolled(this.#id)
    this.#startPollLoop()
    this.#logger.info('VeluxIntegrationManager: started', {
      tags: { gatewayId: this.#id },
      meta: { nodeCount: this.#nodes.size },
    })
  }

  /** Stop the poll loop and drop the client + handles. */
  async stop(): Promise<void> {
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    const client = this.#client
    this.#client = null
    this.#nodes = new Map()
    this.#status = 'disconnected'
    if (client) {
      try {
        await client.disconnect()
      } catch (err) {
        this.#logger.warn('VeluxIntegrationManager: disconnect failed', {
          tags: { gatewayId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, reconnect. */
  async applyConnection(connection: VeluxConnectionConfig): Promise<void> {
    await this.stop()
    this.#connection = connection
    await this.start()
  }

  /** Re-list nodes once, then fan the snapshot out. Best-effort. */
  async poll(): Promise<void> {
    const client = this.#client
    if (client === null) return
    try {
      this.#nodes = indexNodes(await client.listNodes())
    } catch (err) {
      this.#error = errMsg(err)
      this.#logger.debug('VeluxIntegrationManager: node poll failed', {
        tags: { gatewayId: this.#id },
        meta: { error: this.#error },
      })
    }
    this.#onPolled(this.#id)
  }

  #startPollLoop(): void {
    if (this.#pollTimer !== null) return
    this.#pollTimer = setInterval(() => {
      void this.poll().catch((err) => {
        this.#logger.warn('VeluxIntegrationManager: poll cycle failed', {
          tags: { gatewayId: this.#id },
          meta: { error: errMsg(err) },
        })
      })
    }, this.#connection.pollIntervalMs)
    // Do not keep the event loop alive solely for polling.
    this.#pollTimer.unref?.()
  }
}

/** Index a node list by node id. */
function indexNodes(nodes: readonly VeluxNode[]): Map<number, VeluxNode> {
  const map = new Map<number, VeluxNode>()
  for (const node of nodes) map.set(node.nodeId, node)
  return map
}
