import {
  BaseDevice as RademacherBaseDevice,
  CoverDevice,
  Rademacher,
} from '@apocaliss92/noderademacher'
import { errMsg, type IScopedLogger } from '@camstack/types'
import type { RademacherConnectionConfig } from './config.js'

/** Status of a single Rademacher hub connection. */
export type RademacherHubStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

/** Factory seam: build a fresh {@link Rademacher} from a connection (tests inject a fake). */
export type RademacherClientFactory = (connection: RademacherConnectionConfig) => Rademacher

/** Build the real noderademacher client for a connection. Pure. */
export function defaultRademacherClientFactory(connection: RademacherConnectionConfig): Rademacher {
  return new Rademacher({
    host: connection.host,
    ...(connection.password.length > 0 ? { password: connection.password } : {}),
    ...(connection.basePath.length > 0 ? { basePath: connection.basePath } : {}),
  })
}

/** Constructor options for {@link RademacherIntegrationManager}. */
export interface RademacherIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: RademacherConnectionConfig
  readonly logger: IScopedLogger
  readonly onConnected: (hubId: string) => void
  readonly onDisconnected: (hubId: string) => void
  /** Fired after every poll cycle so the hub device fans the fresh snapshot out
   *  to its cover children. */
  readonly onPolled: (hubId: string) => void
  /** Factory seam for testing. */
  readonly makeClient?: RademacherClientFactory
}

/**
 * Wraps exactly one `@apocaliss92/noderademacher` {@link Rademacher} client
 * (= one HomePilot hub). HomePilot has NO push channel, so the manager owns a
 * poll loop: on `start()` it connects, materialises the device handles once,
 * and then periodically calls `device.refresh()` on each, firing `onPolled`
 * after every cycle. Mirrors the Ecowitt / Homematic integration manager.
 *
 * The client is rebuilt from scratch on `applyConnection()` — the manager never
 * reuses a stopped one.
 */
export class RademacherIntegrationManager {
  readonly #id: string
  #connection: RademacherConnectionConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (hubId: string) => void
  readonly #onDisconnected: (hubId: string) => void
  readonly #onPolled: (hubId: string) => void
  readonly #makeClient: RademacherClientFactory

  #client: Rademacher | null = null
  #devices: Map<string, RademacherBaseDevice> = new Map()
  #status: RademacherHubStatus = 'disconnected'
  #pollTimer: ReturnType<typeof setInterval> | null = null
  #error: string | null = null

  constructor(options: RademacherIntegrationManagerOptions) {
    this.#id = options.id
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#onPolled = options.onPolled
    this.#makeClient = options.makeClient ?? defaultRademacherClientFactory
  }

  /** The hub id (= Hub device stableId). */
  get id(): string {
    return this.#id
  }

  /** Current connection status. */
  get status(): RademacherHubStatus {
    return this.#status
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
   * Connect the client, materialise the device handles once, and start the poll
   * loop. Marks `connected` on success. A failed connect throws (the caller logs
   * and keeps the device — a later `applyConnection` / restart retries).
   */
  async start(): Promise<void> {
    if (this.#client !== null) {
      this.#logger.warn('RademacherIntegrationManager: start() called while running — stop first', {
        tags: { hubId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null

    const client = this.#makeClient(this.#connection)
    this.#client = client

    await client.connect()
    // Materialise real device handles once (each is seeded with an initial poll).
    const devices = await client.getDevices({ includeHub: false })
    const map = new Map<string, RademacherBaseDevice>()
    for (const dev of devices) map.set(dev.did, dev)
    this.#devices = map

    this.#status = 'connected'
    this.#onConnected(this.#id)
    this.#onPolled(this.#id)
    this.#startPollLoop()
    this.#logger.info('RademacherIntegrationManager: started', {
      tags: { hubId: this.#id },
      meta: { deviceCount: this.#devices.size },
    })
  }

  /** Stop the poll loop and drop the client + handles. */
  async stop(): Promise<void> {
    if (this.#pollTimer !== null) {
      clearInterval(this.#pollTimer)
      this.#pollTimer = null
    }
    this.#client = null
    this.#devices = new Map()
    this.#status = 'disconnected'
    this.#onDisconnected(this.#id)
  }

  /** Atomically replace the connection: stop, swap config, reconnect. */
  async applyConnection(connection: RademacherConnectionConfig): Promise<void> {
    await this.stop()
    this.#connection = connection
    await this.start()
  }

  /** Poll every device once, then fan the snapshot out. Best-effort per device. */
  async poll(): Promise<void> {
    const devices = [...this.#devices.values()]
    const results = await Promise.allSettled(devices.map((d) => d.refresh()))
    for (const result of results) {
      if (result.status === 'rejected') {
        this.#error = errMsg(result.reason)
        this.#logger.debug('RademacherIntegrationManager: device refresh failed', {
          tags: { hubId: this.#id },
          meta: { error: this.#error },
        })
      }
    }
    this.#onPolled(this.#id)
  }

  #startPollLoop(): void {
    if (this.#pollTimer !== null) return
    this.#pollTimer = setInterval(() => {
      void this.poll().catch((err) => {
        this.#logger.warn('RademacherIntegrationManager: poll cycle failed', {
          tags: { hubId: this.#id },
          meta: { error: errMsg(err) },
        })
      })
    }, this.#connection.pollIntervalMs)
    // Do not keep the event loop alive solely for polling.
    this.#pollTimer.unref?.()
  }
}
