import { errMsg, type IScopedLogger } from '@camstack/types'
import type { VeluxConnectionConfig } from './config.js'
import { KlfGatewayClient } from './klf-gateway-client.js'
import {
  type PowerCycleStore,
  type PowerSourcePort,
  type VeluxRecoveryRecord,
  VeluxPowerRecovery,
} from './velux-power-recovery.js'
import { classifyProbeFailure } from './velux-connection-test.js'
import type { VeluxGatewayStatus, VeluxNodeSource } from './velux-node-resolver.js'
import {
  type VeluxGatewayClient,
  type VeluxGatewayClientFactory,
  VeluxLoginRefusedError,
  type VeluxNode,
} from './velux-client-contract.js'

export type { VeluxGatewayStatus }

/** First reconnect delay; every further failed attempt doubles it. */
export const RECONNECT_BASE_MS = 2_000

/**
 * Longest wait between two connection attempts. The gateway accepts very few
 * sockets, so a hub that cannot log in must not hammer it.
 */
export const RECONNECT_MAX_MS = 5 * 60 * 1000

/**
 * Delay before reconnect attempt number `attempt` (0 = the first retry). A
 * refused password is not going to fix itself in seconds, so it waits the full
 * cap straight away.
 */
export function reconnectDelayMs(attempt: number, passwordRefused: boolean): number {
  if (passwordRefused) return RECONNECT_MAX_MS
  return Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt)
}

/**
 * The first reconnect after an ESTABLISHED session ended waits at least this
 * long. The gateway frees a closed session slowly, and a reconnect inside that
 * window is what leaves it refusing the next TLS handshake.
 */
export const SESSION_ENDED_MIN_RETRY_MS = 30_000

/** The production factory: a real KLF-200 session over the `klf-200-api` library. */
export const defaultVeluxClientFactory: VeluxGatewayClientFactory = (input) =>
  new KlfGatewayClient({
    host: input.host,
    password: input.password,
    logger: input.logger,
  })

/** Constructor options for {@link VeluxIntegrationManager}. */
export interface VeluxIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: VeluxConnectionConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  /** Fired when the node set changed (a push, a (re)connect, or a drop) so the
   *  devices of this gateway re-read their node. */
  readonly onNodesChanged: (integrationId: string) => void
  /** The gateway device's `power-source` link: restarts a wedged gateway. */
  readonly powerSource?: PowerSourcePort
  readonly powerCycleStore?: PowerCycleStore
  /** Factory seam — defaults to the real KLF-200 client. */
  readonly makeClient?: VeluxGatewayClientFactory
}

/**
 * Wraps exactly one live {@link VeluxGatewayClient} (= one KLF-200 session).
 *
 * The gateway PUSHES node changes, so there is no polling: after login the
 * manager only listens. It owns the lifecycle around the session: a failed
 * connect or a session the gateway ended is logged with its reason and retried
 * with bounded exponential backoff (a FRESH client every time), and while the
 * session is down every node reads as offline instead of showing stale state.
 */
export class VeluxIntegrationManager implements VeluxNodeSource {
  readonly #id: string
  readonly #logger: IScopedLogger
  #connection: VeluxConnectionConfig
  readonly #onConnected: (integrationId: string) => void
  readonly #onDisconnected: (integrationId: string) => void
  readonly #onNodesChanged: (integrationId: string) => void
  readonly #makeClient: VeluxGatewayClientFactory

  #client: VeluxGatewayClient | null = null
  #unsubscribe: Array<() => void> = []
  #nodes: Map<number, VeluxNode> = new Map()
  #status: VeluxGatewayStatus = 'disconnected'
  #error: string | null = null
  #firmware: string | null = null
  #wanted = false
  #attempt = 0
  #retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Bumped by every start/stop so a connect that finishes late can tell it was superseded. */
  #generation = 0
  readonly #recovery: VeluxPowerRecovery
  /** When the gateway first became unreachable in the current run of failures; null while reachable. */
  #unreachableSince: number | null = null
  #lastRecovery: VeluxRecoveryRecord | null = null

  constructor(options: VeluxIntegrationManagerOptions) {
    this.#id = options.id
    this.#connection = options.connection
    this.#logger = options.logger.withTags({ integrationId: options.id })
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onNodesChanged = options.onNodesChanged
    this.#makeClient = options.makeClient ?? defaultVeluxClientFactory
    this.#recovery = new VeluxPowerRecovery({
      integrationId: options.id,
      logger: this.#logger,
      ...(options.powerSource === undefined ? {} : { powerSource: options.powerSource }),
      ...(options.powerCycleStore === undefined ? {} : { store: options.powerCycleStore }),
    })
  }

  /** What the last power-cycle recovery did, or null if none ran since this manager started. */
  get lastRecovery(): VeluxRecoveryRecord | null {
    return this.#lastRecovery
  }

  /** The integration id this session belongs to. */
  get id(): string {
    return this.#id
  }

  /** Current connection status. */
  get status(): VeluxGatewayStatus {
    return this.#status
  }

  /** Why the last connection attempt failed, or null. */
  get lastError(): string | null {
    return this.#error
  }

  /** Firmware the gateway reported on the last connect, or null while unknown. */
  get firmware(): string | null {
    return this.#firmware
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): VeluxConnectionConfig {
    return this.#connection
  }

  /** All actuator nodes known to this gateway (last known state). */
  getNodes(): readonly VeluxNode[] {
    return [...this.#nodes.values()]
  }

  /** Resolve a single node by its node id, or null. */
  getNode(nodeId: number): VeluxNode | null {
    return this.#nodes.get(nodeId) ?? null
  }

  /** The live client while a session is up, otherwise null. Cover children drive commands here. */
  get client(): VeluxGatewayClient | null {
    return this.#status === 'connected' ? this.#client : null
  }

  /**
   * Begin connecting. Never throws: a failure is logged, the status becomes
   * `error` and a retry is scheduled, so a gateway that is offline at boot comes
   * up by itself later.
   */
  async start(): Promise<void> {
    if (this.#wanted) {
      this.#logger.warn('velux: start() called while running — stop first', {
        meta: {},
      })
      return
    }
    this.#wanted = true
    this.#attempt = 0
    this.#unreachableSince = null
    this.#generation += 1
    await this.#connect()
  }

  /** Close the session, cancel any pending reconnect and forget the nodes. */
  async stop(): Promise<void> {
    this.#wanted = false
    this.#generation += 1
    this.#cancelRetry()
    this.#recovery.abort()
    const client = this.#client
    this.#detach()
    this.#nodes = new Map()
    this.#status = 'disconnected'
    if (client !== null) {
      try {
        await client.disconnect()
      } catch (err) {
        this.#logger.warn('velux: disconnect failed', {
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

  async #connect(): Promise<void> {
    if (!this.#wanted || this.#client !== null) return
    const generation = this.#generation
    this.#status = 'connecting'
    const client = this.#makeClient({
      host: this.#connection.host,
      password: this.#connection.password,
      logger: this.#logger,
    })
    this.#client = client
    try {
      await client.connect()
    } catch (err) {
      if (generation !== this.#generation) return
      this.#client = null
      this.#failed(err)
      return
    }
    if (generation !== this.#generation) {
      await client.disconnect().catch(() => undefined)
      return
    }
    this.#unsubscribe.push(
      client.onNodeChanged((node) => {
        this.#nodes.set(node.nodeId, node)
        this.#onNodesChanged(this.#id)
      }),
      client.onDisconnected((event) => this.#lost(event.reason)),
    )
    this.#nodes = new Map(client.listNodes().map((node) => [node.nodeId, node]))
    this.#status = 'connected'
    this.#error = null
    this.#attempt = 0
    this.#unreachableSince = null
    this.#onConnected(this.#id)
    this.#onNodesChanged(this.#id)
    await this.#readFirmware(client, generation)
    this.#logger.info('velux: connected', {
      meta: { nodeCount: this.#nodes.size, firmware: this.#firmware },
    })
  }

  /** Best effort: a gateway that logged us in but will not say its version is still usable. */
  async #readFirmware(client: VeluxGatewayClient, generation: number): Promise<void> {
    try {
      const firmware = await client.readVersion()
      if (generation !== this.#generation) return
      this.#firmware = firmware
      this.#onNodesChanged(this.#id)
    } catch (err) {
      this.#logger.warn('velux: firmware version read failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  #failed(err: unknown): void {
    const refused = err instanceof VeluxLoginRefusedError
    this.#error = errMsg(err)
    this.#status = 'error'
    const delay = reconnectDelayMs(this.#attempt, refused)
    this.#attempt += 1
    this.#logger.warn('velux: connect failed', {
      meta: {
        error: this.#error,
        retryInMs: delay,
        attempt: this.#attempt,
      },
    })
    this.#scheduleRetry(delay)
    this.#trackUnreachable(err, refused)
    void this.#maybeRecover()
  }

  /** A run of failures that say "cannot reach it" (refused, timeout, TLS); a wrong password is not one. */
  #trackUnreachable(err: unknown, refused: boolean): void {
    if (refused) {
      this.#unreachableSince = null
      return
    }
    const kind = classifyProbeFailure(err).kind
    if ((kind === 'unreachable' || kind === 'tls') && this.#unreachableSince === null) {
      this.#unreachableSince = Date.now()
    }
  }

  /** Power-cycle the gateway when it has been unreachable long enough and a switch is set. */
  async #maybeRecover(): Promise<void> {
    const since = this.#unreachableSince
    if (since === null || !this.#wanted) return
    const generation = this.#generation
    const result = await this.#recovery.maybeRecover({
      unreachableForMs: Date.now() - since,
      hasLiveSession: this.#status === 'connected',
      onCycleStart: () => this.#cancelRetry(),
    })
    if (result.kind !== 'done') return
    this.#lastRecovery = result.record
    if (generation !== this.#generation || !this.#wanted) return
    this.#attempt = 0
    this.#unreachableSince = null
    this.#logger.info('velux: reconnecting after the power cycle', {
      meta: { outcome: result.record.outcome },
    })
    await this.#connect()
  }

  /** The gateway ended an ESTABLISHED session. */
  #lost(reason: string): void {
    if (!this.#wanted) return
    this.#logger.warn('velux: session ended', {
      meta: { reason },
    })
    this.#detach()
    this.#error = reason
    this.#status = 'disconnected'
    this.#nodes = new Map(
      [...this.#nodes.values()].map((node) => [node.nodeId, { ...node, online: false }]),
    )
    this.#onNodesChanged(this.#id)
    this.#onDisconnected(this.#id)
    const delay = Math.max(SESSION_ENDED_MIN_RETRY_MS, reconnectDelayMs(this.#attempt, false))
    this.#attempt += 1
    this.#scheduleRetry(delay)
  }

  #detach(): void {
    for (const off of this.#unsubscribe.splice(0)) off()
    this.#client = null
  }

  #scheduleRetry(delayMs: number): void {
    this.#cancelRetry()
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null
      void this.#connect()
    }, delayMs)
    // A pending retry must not keep the process alive on its own.
    this.#retryTimer.unref?.()
  }

  #cancelRetry(): void {
    if (this.#retryTimer !== null) clearTimeout(this.#retryTimer)
    this.#retryTimer = null
  }
}
