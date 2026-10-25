import { errMsg, type IScopedLogger } from '@camstack/types'
import { type ShcConfig, sameShcConnection } from './config.js'
import { nameShcDevices } from './shc-parse-devices.js'
import { ShcClient, type ShcClientDeps } from './shc-client.js'
import type { ShcConnectionSurface } from './shc-gateway.js'
import type { ShcDeviceSummary } from './shc-types.js'

export type ShcBrokerStatus = 'connected' | 'disconnected' | 'connecting' | 'error'

export interface ShcBrokerInfo {
  readonly id: string
  readonly name: string
  readonly kind: 'bosch-shc'
  readonly status: ShcBrokerStatus
  readonly info: Record<string, unknown>
  readonly lastCheckedAt: number | null
  readonly error: string | null
}

export interface ShcSurfaceSink {
  set(integrationId: string, surface: ShcConnectionSurface | null): void
}

export type ShcClientFactory = (config: ShcConfig, deps?: ShcClientDeps) => ShcClient

export interface ShcIntegrationManagerOptions {
  readonly id: string
  readonly name: string
  readonly connection: ShcConfig
  readonly logger: IScopedLogger
  readonly onConnected: (integrationId: string) => void
  readonly onDisconnected: (integrationId: string) => void
  readonly surfaceSink: ShcSurfaceSink
  readonly makeClient?: ShcClientFactory
}

export function defaultShcClient(config: ShcConfig): ShcClient {
  return new ShcClient(config)
}

export class ShcIntegrationManager {
  readonly #id: string
  readonly #name: string
  #connection: ShcConfig
  readonly #logger: IScopedLogger
  readonly #onConnected: (integrationId: string) => void
  readonly #onDisconnected: (integrationId: string) => void
  readonly #surfaceSink: ShcSurfaceSink
  readonly #makeClient: ShcClientFactory

  #client: ShcClient | null = null
  #devices: ShcDeviceSummary[] = []
  #status: ShcBrokerStatus = 'disconnected'
  #lastCheckedAt: number | null = null
  #error: string | null = null

  constructor(options: ShcIntegrationManagerOptions) {
    this.#id = options.id
    this.#name = options.name
    this.#connection = options.connection
    this.#logger = options.logger
    this.#onConnected = options.onConnected
    this.#onDisconnected = options.onDisconnected
    this.#surfaceSink = options.surfaceSink
    this.#makeClient = options.makeClient ?? defaultShcClient
  }

  getConnection(): ShcConfig {
    return this.#connection
  }

  getInfo(): ShcBrokerInfo {
    return {
      id: this.#id,
      name: this.#name,
      kind: 'bosch-shc',
      status: this.#status,
      info: { host: this.#connection.host, deviceCount: this.#devices.length },
      lastCheckedAt: this.#lastCheckedAt,
      error: this.#error,
    }
  }

  async start(): Promise<void> {
    if (this.#client !== null) {
      this.#logger.warn('ShcIntegrationManager: start() while running — stop first', {
        tags: { integrationId: this.#id },
      })
      return
    }
    this.#status = 'connecting'
    this.#error = null

    const client = this.#makeClient(this.#connection)
    this.#client = client

    try {
      const listed = await client.listDevices()
      const rooms = await client.listRooms()
      const devices = nameShcDevices(listed, rooms)
      this.#devices = devices
      client.startLongPoll()
      const surface: ShcConnectionSurface = { devices, client }
      this.#surfaceSink.set(this.#id, surface)
      this.#status = 'connected'
      this.#lastCheckedAt = Date.now()
      this.#onConnected(this.#id)
      this.#logger.info('ShcIntegrationManager: connected', {
        tags: { integrationId: this.#id },
        meta: { host: this.#connection.host, deviceCount: devices.length },
      })
    } catch (err: unknown) {
      this.#status = 'error'
      this.#error = errMsg(err)
      this.#lastCheckedAt = Date.now()
      this.#surfaceSink.set(this.#id, null)
      client.close()
      this.#client = null
      this.#onDisconnected(this.#id)
      this.#logger.warn('ShcIntegrationManager: connect failed', {
        tags: { integrationId: this.#id },
        meta: { error: this.#error },
      })
      throw err
    }
  }

  async stop(): Promise<void> {
    const client = this.#client
    this.#client = null
    this.#devices = []
    this.#status = 'disconnected'
    this.#surfaceSink.set(this.#id, null)
    if (client) {
      try {
        client.close()
      } catch (err: unknown) {
        this.#logger.warn('ShcIntegrationManager: client close failed', {
          tags: { integrationId: this.#id },
          meta: { error: errMsg(err) },
        })
      }
    }
    this.#onDisconnected(this.#id)
  }

  async applyConnection(conn: ShcConfig): Promise<void> {
    await this.stop()
    this.#connection = conn
    await this.start()
  }
}

export { sameShcConnection as sameConnection }
