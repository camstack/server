import {
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  DeviceType,
  type IDevice,
  userError,
} from '@camstack/types'
import {
  buildConnectionFormSchema,
  settingsToConnection,
  slugifyHost,
  type VeluxConnectionConfig,
  veluxConnectionSchema,
} from './config.js'
import { VeluxCoverDevice } from './devices/velux-cover-device.js'
import { VeluxGatewayDevice } from './devices/velux-gateway-device.js'
import { VeluxRainSensorDevice } from './devices/velux-rain-sensor-device.js'

/**
 * Velux KLF-200 device-provider addon — `mode: standalone` (the Reolink /
 * Rademacher pattern). No broker, no device-adoption cap. A gateway is added as a
 * DEVICE via the manual-creation form: the CONNECTION (host / password / poll
 * interval) lives on the gateway DEVICE config. The created gateway is a
 * {@link DeviceType.Hub} ({@link VeluxGatewayDevice}) that owns its own live
 * client and registers `device-discovery` to adopt its own window / shutter
 * children as {@link DeviceType.Cover} devices.
 *
 * The live session is the `klf-200-api` library behind {@link KlfGatewayClient}:
 * one TLS socket per gateway, node changes PUSHED by the gateway, a keepalive
 * and a bounded-backoff reconnect (see the README for the gateway's connection
 * limit).
 *
 * `instanceMode: multiple` — many gateways may be added. Network auto-discovery
 * is not implemented (the KLF-200 has no broadcast beacon we probe); the gateway
 * is added by host.
 */
export class VeluxProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-velux'
  protected readonly providerName = 'Velux'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Hub]: VeluxGatewayDevice,
    [DeviceType.Cover]: VeluxCoverDevice,
    [DeviceType.Sensor]: VeluxRainSensorDevice,
  }

  constructor() {
    super({})
  }

  // ── No network auto-discovery for the gateway itself ────────────────────────

  override async supportsDiscovery(): Promise<boolean> {
    return false
  }

  // ── Manual creation: a gateway is added as a Hub device ─────────────────────

  override async supportsManualCreation(): Promise<boolean> {
    return true
  }

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    // Only the gateway is manually creatable; its cover children are spawned by
    // the gateway's `device-discovery` adopt flow.
    if (type !== DeviceType.Hub) return null
    return buildConnectionFormSchema()
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    if (type !== DeviceType.Hub) {
      throw new Error(`Velux provider does not support device type: ${type}`)
    }
    const name = typeof config['name'] === 'string' ? config['name'].trim() : ''
    if (!name) throw userError('velux.name-required', undefined, 'Gateway name is required')

    const connection = extractConnection(config)
    if (connection.host.trim().length === 0) {
      throw userError('velux.host-required', undefined, 'Gateway host is required')
    }

    return {
      meta: { type: DeviceType.Hub, name },
      // The gateway device builds its own live client when it activates.
      config: { connection, system: 'velux-gateway' },
    }
  }

  /**
   * Gateway stableId — derived from the connection host (Reolink-style identity
   * key). Re-adding the same gateway reuses its persisted row.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const connection = readConnection(config)
    const host = connection?.host.trim() ?? ''
    if (host.length > 0) return `velux:${slugifyHost(host)}`
    throw new Error('Velux: gateway resolved no host endpoint — cannot persist a stable row key.')
  }
}

/** Narrow the create-spec / stable-id config's `connection` to a validated config. */
function extractConnection(config: Record<string, unknown>): VeluxConnectionConfig {
  return settingsToConnection(config['connection'] ?? config)
}

/** Best-effort connection read for `generateStableId` (no throw on partial input). */
function readConnection(config: Record<string, unknown> | undefined): VeluxConnectionConfig | null {
  if (config === undefined) return null
  const raw = config['connection'] ?? config
  const parsed = veluxConnectionSchema.safeParse(typeof raw === 'object' && raw !== null ? raw : {})
  return parsed.success ? parsed.data : null
}
