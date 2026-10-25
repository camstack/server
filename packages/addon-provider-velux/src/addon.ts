import { userError } from '@camstack/types'
import {
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  DeviceType,
  type IDevice,
  errMsg,
} from '@camstack/types'
import {
  buildConnectionFormSchema,
  type VeluxConnectionConfig,
  settingsToConnection,
  slugifyHost,
  veluxConnectionSchema,
} from './config.js'
import { VeluxCoverDevice } from './devices/velux-cover-device.js'
import { VeluxGatewayDevice } from './devices/velux-gateway-device.js'
import { veluxGateways } from './velux-node-resolver.js'
import { VeluxIntegrationManager } from './velux-integration-manager.js'

/**
 * Velux KLF-200 device-provider addon — `mode: standalone` (the Reolink /
 * Rademacher pattern). No broker, no device-adoption cap. A gateway is added as a
 * DEVICE via the manual-creation form: the CONNECTION (host / password / poll
 * interval) lives on the gateway DEVICE config. The created gateway is a
 * {@link DeviceType.Hub} ({@link VeluxGatewayDevice}) that owns its own live
 * client and registers `device-discovery` to adopt its own window / shutter
 * children as {@link DeviceType.Cover} devices.
 *
 * NOTE: no KLF-200 client library is wired yet (see `plan-velux.md`) — the
 * integration manager's default factory throws until one is implemented, so a
 * created gateway installs cleanly but stays offline. Everything else (config,
 * discovery flow, cover cap surface) is complete and type-checked.
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

    // Build the live client ONCE here so the gateway device adopts a warm client.
    // With no library wired, `start()` throws — caught + logged, the device is
    // kept so the row persists for when the library lands.
    const stableId = this.generateStableId(DeviceType.Hub, { connection })
    const manager = new VeluxIntegrationManager({
      id: stableId,
      name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: (gatewayId) => veluxGateways.emitSnapshot(gatewayId),
    })
    veluxGateways.set(stableId, manager)
    try {
      await manager.start()
    } catch (err) {
      this.ctx.logger.warn('Velux create: initial client connect failed — device kept', {
        meta: { stableId, error: errMsg(err) },
      })
    }

    return {
      meta: { type: DeviceType.Hub, name },
      config: { connection, system: 'velux-gateway' },
      onAfterCreate: async (device: IDevice) => {
        if (device instanceof VeluxGatewayDevice) {
          device.adoptManager(manager)
        }
      },
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
