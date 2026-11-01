import type { Sensor } from '@apocaliss92/nodewitt'
import { errMsg, type IScopedLogger } from '@camstack/types'
import { sameConnection, type EcowittConfig } from './config.js'
import { ecowittFacades } from './ecowitt-gateway.js'
import { EcowittIntegrationManager } from './ecowitt-integration-manager.js'

export interface EcowittClientRegistryDeps {
  /** The client of an integration came up or went down. */
  readonly onOnline: (integrationId: string, gatewayKey: string, online: boolean) => void
  /** The gateway reported a fresh sensor set. */
  readonly onSensors: (
    integrationId: string,
    gatewayKey: string,
    sensors: readonly Sensor[],
  ) => void
}

interface EcowittClientEntry {
  readonly manager: EcowittIntegrationManager
  readonly gatewayKey: string
  readonly connection: EcowittConfig
}

/** The connection each running integration dials, for the Gateway device's admin link. */
class EcowittConnections {
  readonly #byIntegration = new Map<string, EcowittConfig>()
  set(integrationId: string, connection: EcowittConfig | null): void {
    if (connection === null) this.#byIntegration.delete(integrationId)
    else this.#byIntegration.set(integrationId, connection)
  }
  get(integrationId: string): EcowittConfig | null {
    return this.#byIntegration.get(integrationId) ?? null
  }
  clear(): void {
    this.#byIntegration.clear()
  }
}

export const ecowittConnections = new EcowittConnections()

/**
 * One live nodewitt client per Ecowitt integration, published on {@link ecowittFacades} under the
 * integration's gateway key so its Containers and sensors read through it. The addon reconciles
 * it against the integration list at boot and on every lifecycle event.
 */
export class EcowittClientRegistry {
  readonly #logger: IScopedLogger
  readonly #deps: EcowittClientRegistryDeps
  readonly #entries = new Map<string, EcowittClientEntry>()

  constructor(logger: IScopedLogger, deps: EcowittClientRegistryDeps) {
    this.#logger = logger
    this.#deps = deps
  }

  /**
   * Ensure a client runs for `integrationId` with this connection. An unchanged one is kept, a
   * changed one replaced. Never throws: a gateway that is off is logged, and the device stays.
   */
  async upsert(
    integrationId: string,
    gatewayKey: string,
    name: string,
    connection: EcowittConfig,
  ): Promise<void> {
    const existing = this.#entries.get(integrationId)
    if (existing !== undefined) {
      if (existing.gatewayKey === gatewayKey && sameConnection(existing.connection, connection)) {
        return
      }
      await this.remove(integrationId)
    }
    const manager = new EcowittIntegrationManager({
      id: integrationId,
      name,
      connection,
      logger: this.#logger.withTags({ integrationId }),
      onConnected: () => this.#deps.onOnline(integrationId, gatewayKey, true),
      onDisconnected: () => this.#deps.onOnline(integrationId, gatewayKey, false),
      onSensorsChanged: (_id, sensors) => {
        this.#deps.onSensors(integrationId, gatewayKey, sensors)
        ecowittFacades.emitSnapshot(gatewayKey)
      },
      onFacadeBuilt: (_id, facade) => ecowittFacades.set(gatewayKey, facade),
    })
    this.#entries.set(integrationId, { manager, gatewayKey, connection })
    ecowittConnections.set(integrationId, connection)
    try {
      await manager.start()
    } catch (err) {
      this.#logger.warn('Ecowitt client start failed — retried on the next reconcile', {
        meta: { integrationId, error: errMsg(err) },
      })
    }
  }

  async remove(integrationId: string): Promise<void> {
    const entry = this.#entries.get(integrationId)
    if (entry === undefined) return
    this.#entries.delete(integrationId)
    ecowittConnections.set(integrationId, null)
    await entry.manager.stop()
    ecowittFacades.set(entry.gatewayKey, null)
  }

  /** Stop every client whose integration is not in `keep`. */
  async retain(keep: ReadonlySet<string>): Promise<void> {
    for (const id of [...this.#entries.keys()]) {
      if (!keep.has(id)) await this.remove(id)
    }
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.#entries.keys()]) await this.remove(id)
  }

  has(integrationId: string): boolean {
    return this.#entries.has(integrationId)
  }

  list(): readonly string[] {
    return [...this.#entries.keys()]
  }

  gatewayKeyOf(integrationId: string): string | null {
    return this.#entries.get(integrationId)?.gatewayKey ?? null
  }

  /** Whether the client of this integration is up. */
  isOnline(integrationId: string): boolean {
    const entry = this.#entries.get(integrationId)
    return entry !== undefined && ecowittFacades.get(entry.gatewayKey) !== null
  }
}
