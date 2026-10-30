import { userError } from '@camstack/types'
import {
  BaseDeviceProvider,
  DeviceType,
  errMsg,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  type DeviceSummary,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
  type IDevice,
} from '@camstack/types'
import {
  buildConnectionFormSchema,
  settingsToEcowittConfig,
  slugifyHost,
  type EcowittConfig,
} from './config.js'
import { EcowittIntegrationManager } from './ecowitt-integration-manager.js'
import {
  ECOWITT_DISCOVERY_MODES,
  ecowittCandidates,
  ecowittGatewaysFromHits,
} from './ecowitt-lan-discovery.js'
import { ecowittFacades } from './ecowitt-gateway.js'
import { EcowittGatewayDevice } from './devices/ecowitt-gateway-device.js'
import { EcowittContainerDevice } from './devices/ecowitt-container-device.js'

/**
 * Ecowitt weather-station device-provider addon — `mode: standalone` (the
 * Reolink pattern). No broker, no device-adoption cap. A gateway is added as a
 * DEVICE via the manual-creation form: the CONNECTION (transport / host / port /
 * password OR listener) lives on the gateway DEVICE config. The created gateway
 * is a {@link DeviceType.Hub} ({@link EcowittGatewayDevice}) that owns its own
 * live `@apocaliss92/nodewitt` client and registers `device-discovery` to adopt
 * its own children: up to THREE group {@link DeviceType.Container} children
 * (gateway / weather-station / temp-sensor-ch1), each fanning out one typed
 * sensor child per `Sensor.quantity`.
 *
 * `instanceMode: multiple` — many gateways may be added.
 */
export class EcowittProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-ecowitt'
  protected readonly providerName = 'Ecowitt'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Hub]: EcowittGatewayDevice,
    [DeviceType.Container]: EcowittContainerDevice,
  }

  constructor() {
    super({})
  }

  // ── Discovery: the scan engine broadcasts, this addon classifies the replies ──

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async getDiscoveryModes(): Promise<readonly DiscoveryMode[]> {
    return ECOWITT_DISCOVERY_MODES
  }

  override async classifyDiscoveryHits(input: {
    hits: readonly DiscoveryHit[]
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    const gateways = ecowittGatewaysFromHits(input.hits)
    this.ctx.logger.info('Ecowitt discovery complete', { meta: { count: gateways.length } })
    return ecowittCandidates(gateways)
  }

  override async adoptDiscoveredDevice(input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    // Reuse the manual-creation path: onCreateDevice starts the live client against the discovered
    // gateway host and adopts a warm handle (same as a hand-typed Add).
    return this.createDevice({
      type: DeviceType.Hub,
      config: input.candidate.prefilledConfig,
    })
  }

  // ── Manual creation: a gateway is added as a Hub device ────────────────

  override async supportsManualCreation(): Promise<boolean> {
    return true
  }

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    // Only the gateway Hub is manually creatable; its group Containers + sensor
    // children are spawned by the gateway's `device-discovery` adopt flow.
    if (type !== DeviceType.Hub) return null
    return buildConnectionFormSchema()
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    if (type !== DeviceType.Hub) {
      throw new Error(`Ecowitt provider does not support device type: ${type}`)
    }
    const name = typeof config['name'] === 'string' ? config['name'].trim() : ''
    if (!name) throw userError('ecowitt.name-required', undefined, 'Gateway name is required')

    const connection = settingsToEcowittConfig(config)
    if (connection.transport === 'local' && connection.host.trim().length === 0) {
      throw userError(
        'ecowitt.host-required',
        undefined,
        'Gateway host is required for local-poll transport',
      )
    }

    // Start the live client ONCE here so the gateway device adopts a warm client
    // (mirrors Reolink reusing the autodetect socket). The manager keys the
    // in-process facade resolver on the gateway's stableId — resolved below so
    // create + adopt use the same key.
    const stableId = this.generateStableId(DeviceType.Hub, { connection })
    const manager = new EcowittIntegrationManager({
      id: stableId,
      name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onSensorsChanged: () => undefined,
      onFacadeBuilt: (_id, facade) => ecowittFacades.set(stableId, facade),
    })
    try {
      await manager.start()
    } catch (err) {
      this.ctx.logger.warn('Ecowitt create: initial client start failed — device kept', {
        meta: { stableId, error: errMsg(err) },
      })
    }

    return {
      meta: { type: DeviceType.Hub, name },
      config: { connection, system: 'ecowitt-gateway' },
      onAfterCreate: async (device: IDevice) => {
        if (device instanceof EcowittGatewayDevice) {
          device.adoptManager(manager)
        }
      },
    }
  }

  /**
   * Gateway stableId — derived from the connection (Reolink-style host/identity
   * key), NOT a broker id. Priority: `stationId` (operator-provided stable id) →
   * `host` (local transport) → `listen:<port>` (listener transport). Re-adding
   * the same gateway reuses its persisted row.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const connection = extractConnection(config)
    const station = typeof connection?.stationId === 'string' ? connection.stationId.trim() : ''
    if (station.length > 0) return `ecowitt:${slugifyHost(station)}`
    if (connection?.transport === 'local') {
      const host = connection.host.trim()
      if (host.length > 0) return `ecowitt:${slugifyHost(host)}`
    }
    if (connection?.transport === 'listener') {
      return `ecowitt:listen-${connection.listenPort}`
    }
    // No stable identity resolvable — refuse the row (matches Reolink).
    throw new Error(
      'Ecowitt: gateway resolved neither a station id nor a host/listen endpoint — cannot persist a stable row key.',
    )
  }
}

/** Narrow the create-spec config's `connection` field to an {@link EcowittConfig}. */
function extractConnection(config: Record<string, unknown> | undefined): EcowittConfig | null {
  const raw = config?.['connection']
  if (typeof raw !== 'object' || raw === null) return null
  const transport = (raw as { transport?: unknown }).transport
  if (transport !== 'local' && transport !== 'listener') return null
  return settingsToEcowittConfig(raw)
}
