import {
  type BaseDevice as RademacherBaseDevice,
  CoverDevice,
  type HubIdentity,
  Rademacher,
} from '@apocaliss92/noderademacher'
import { errMsg, type IScopedLogger } from '@camstack/types'
import type { RademacherConnectionConfig } from './config.js'

/** Status of a single Rademacher hub connection. */
export type RademacherHubStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** The part of the noderademacher client the manager uses (the real {@link Rademacher} fits). */
export interface RademacherClient {
  connect(): Promise<void>
  getDevices(options?: { includeHub?: boolean }): Promise<RademacherBaseDevice[]>
  getIdentity(): Readonly<HubIdentity> | null
}

/** Factory seam: build a fresh client from a connection (tests inject a fake). */
export type RademacherClientFactory = (connection: RademacherConnectionConfig) => RademacherClient

/** Build the real noderademacher client for a connection. Pure. */
export function defaultRademacherClientFactory(
  connection: RademacherConnectionConfig,
): RademacherClient {
  return new Rademacher({
    host: connection.host,
    ...(connection.password.length > 0 ? { password: connection.password } : {}),
    ...(connection.basePath.length > 0 ? { basePath: connection.basePath } : {}),
  })
}

/** First reconnect delay, doubled per failed attempt up to {@link RECONNECT_MAX_MS}. */
export const RECONNECT_BASE_MS = 5_000
export const RECONNECT_MAX_MS = 60_000

/** Constructor options for {@link RademacherIntegrationManager}. */
export interface RademacherIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: RademacherConnectionConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  /** Fired after every poll cycle so the devices of the integration refresh from the fresh snapshot. */
  readonly onPolled: (integrationId: string) => void
  /** Factory seam for testing. */
  readonly makeClient?: RademacherClientFactory
  /** Reconnect base delay (tests shorten it). */
  readonly reconnectBaseMs?: number
}

/**
 * Wraps exactly one `@apocaliss92/noderademacher` client (= one HomePilot hub,
 * = one integration). HomePilot has NO push channel, so the manager owns a poll
 * loop: on `start()` it connects, materialises the device handles once, and then
 * periodically calls `device.refresh()` on each, firing `onPolled` after every
 * cycle.
 *
 * `start()` never throws. A hub that is down is retried with a bounded backoff,
 * and a poll cycle in which EVERY device refresh failed marks the session down
 * (`onDisconnected`) until one succeeds again — the hub has no socket whose
 * close would say so.
 */
export class RademacherIntegrationManager {
  readonly #id: string
  #name: string
  #connection: RademacherConnectionConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (integrationId: string) => void
  readonly #onDisconnected: (integrationId: string) => void
  readonly #onPolled: (integrationId: string) => void
  readonly #makeClient: RademacherClientFactory
  readonly #reconnectBaseMs: number

  #client: RademacherClient | null = null
  #devices: Map<string, RademacherBaseDevice> = new Map()
  #identity: Readonly<HubIdentity> | null = null
  #status: RademacherHubStatus = 'disconnected'
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null
  #attempts = 0
  #generation = 0
  #error: string | null = null

  constructor(options: RademacherIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onPolled = options.onPolled
    this.#makeClient = options.makeClient ?? defaultRademacherClientFactory
    this.#reconnectBaseMs = options.reconnectBaseMs ?? RECONNECT_BASE_MS
  }

  /** The integration id. */
  get id(): string {
    return this.#id
  }

  /** The operator's name for the integration. */
  get name(): string {
    return this.#name
  }

  /** Current connection status. */
  get status(): RademacherHubStatus {
    return this.#status
  }

  /** The last connect or poll error, or null while healthy. */
  get lastError(): string | null {
    return this.#error
  }

  /** What the hub reported about itself on connect (model, firmware, MAC), or null before then. */
  get identity(): Readonly<HubIdentity> | null {
    return this.#identity
  }

  /** The connection settings the manager is currently configured with. */
  getConnection(): RademacherConnectionConfig {
    return this.#connection
  }

  /** All cover (roller-shutter) handles known to this hub. */
  getCovers(): readonly CoverDevice[] {
    const out: CoverDevice[] = []
    for (const dev of this.#devices.values()) {
      if (dev instanceof CoverDevice) out.push(dev)
    }
    return out
  }

  /** Resolve a single cover handle by its HomePilot device id, or null. */
  getCover(did: string): CoverDevice | null {
    const dev = this.#devices.get(did)
    return dev instanceof CoverDevice ? dev : null
  }

  /**
   * Connect the client, materialise the device handles once and start the poll
   * loop. Never throws: a failed connect is logged and retried with backoff.
   */
  async start(): Promise<void> {
    if (this.#client !== null || this.#reconnectTimer !== null) {
      this.#logger.warn('RademacherIntegrationManager: start() called while running — stop first', {
        tags: { integrationId: this.#id },
      })
      return
    }
    await this.#connectOnce(this.#generation)
  }

  /** Stop the poll loop and any pending reconnect, drop the client and handles. */
  async stop(): Promise<void> {
    this.#generation += 1
    this.#clearTimers()
    const wasUp = this.#status === 'connected'
    this.#client = null
    this.#devices = new Map()
    this.#status = 'disconnected'
    this.#attempts = 0
    if (wasUp) this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, reconnect. */
  async applyConnection(connection: RademacherConnectionConfig, name?: string): Promise<void> {
    await this.stop()
    this.#connection = connection
    if (name !== undefined) this.#name = name
    await this.start()
  }

  /** Poll every device once, then fan the snapshot out. Best-effort per device. */
  async poll(): Promise<void> {
    const devices = [...this.#devices.values()]
    const results = await Promise.allSettled(devices.map((d) => d.refresh()))
    const failed = results.filter((r) => r.status === 'rejected')
    for (const result of failed) {
      this.#error = errMsg(result.reason)
      this.#logger.debug('RademacherIntegrationManager: device refresh failed', {
        tags: { integrationId: this.#id },
        meta: { error: this.#error },
      })
    }
    if (devices.length > 0 && failed.length === devices.length) {
      if (this.#status === 'connected') {
        this.#status = 'error'
        this.#logger.warn('RademacherIntegrationManager: hub stopped answering', {
          tags: { integrationId: this.#id },
          meta: { error: this.#error },
        })
        this.#onDisconnected(this.#id)
      }
    } else if (devices.length > 0 && this.#status === 'error') {
      this.#status = 'connected'
      this.#error = null
      this.#logger.info('RademacherIntegrationManager: hub answers again', {
        tags: { integrationId: this.#id },
      })
      this.#onConnected(this.#id)
    }
    this.#onPolled(this.#id)
  }

  async #connectOnce(generation: number): Promise<void> {
    this.#status = 'connecting'
    this.#error = null
    try {
      const client = this.#makeClient(this.#connection)
      await client.connect()
      // Materialise real device handles once (each is seeded with an initial poll).
      const devices = await client.getDevices({ includeHub: false })
      if (generation !== this.#generation) return
      const map = new Map<string, RademacherBaseDevice>()
      for (const dev of devices) map.set(dev.did, dev)
      this.#client = client
      this.#devices = map
      this.#identity = client.getIdentity()
      this.#status = 'connected'
      this.#attempts = 0
      this.#onConnected(this.#id)
      this.#onPolled(this.#id)
      this.#startPollLoop()
      this.#logger.info('RademacherIntegrationManager: started', {
        tags: { integrationId: this.#id },
        meta: { deviceCount: this.#devices.size },
      })
    } catch (err) {
      if (generation !== this.#generation) return
      this.#status = 'error'
      this.#error = errMsg(err)
      this.#attempts += 1
      const delay = Math.min(
        this.#reconnectBaseMs * 2 ** (this.#attempts - 1),
        Math.max(RECONNECT_MAX_MS, this.#reconnectBaseMs),
      )
      this.#logger.warn('RademacherIntegrationManager: connect failed, retrying', {
        tags: { integrationId: this.#id },
        meta: { error: this.#error, attempt: this.#attempts, retryInMs: delay },
      })
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectTimer = null
        void this.#connectOnce(generation)
      }, delay)
      this.#reconnectTimer.unref?.()
    }
  }

  #clearTimers(): void {
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    if (this.#reconnectTimer !== null) {
      clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = null
    }
  }

  #startPollLoop(): void {
    if (this.#pollTimer !== null) return
    this.#pollTimer = setInterval(() => {
      void this.poll().catch((err) => {
        this.#logger.warn('RademacherIntegrationManager: poll cycle failed', {
          tags: { integrationId: this.#id },
          meta: { error: errMsg(err) },
        })
      })
    }, this.#connection.pollIntervalMs)
    // Do not keep the event loop alive solely for polling.
    this.#pollTimer.unref?.()
  }
}
