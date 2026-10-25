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
  buildControllerFormSchema,
  settingsToConnection,
  slugifyHost,
  type UnifiConnectionConfig,
  unifiConnectionSchema,
} from './config.js'
import { UnifiControllerDevice } from './devices/unifi-controller-device.js'
import { UnifiFeatureDevice } from './devices/unifi-feature-device.js'
import { UnifiInfraDevice } from './devices/unifi-infra-device.js'
import { unifiControllers } from './unifi-node-resolver.js'
import { UnifiIntegrationManager } from './unifi-integration-manager.js'

/**
 * UniFi Network **controller** device-provider addon — `mode: standalone` (the
 * Reolink / Velux / Ecowitt pattern). LOCAL controller API only; cameras are
 * not in scope. No broker, no device-adoption cap. A controller is
 * added as a DEVICE via the manual-creation form: the CONNECTION (host / port /
 * apiKey-or-username+password / site / poll interval) lives on the controller
 * DEVICE config. The created controller is a {@link DeviceType.Hub}
 * ({@link UnifiControllerDevice}) that owns its own live client and registers
 * `device-discovery` to adopt its own infra devices (as
 * {@link DeviceType.Container}) + network clients (as {@link DeviceType.Presence}).
 *
 * NOTE: no UniFi controller-API client library is wired yet (see `plan-unifi.md`)
 * — the integration manager's default factory throws until one is implemented
 * (chosen lib: `node-unifi`), so a created controller installs cleanly but stays
 * offline. Everything else (config, discovery flow, cap surfaces) is complete and
 * type-checked.
 *
 * `instanceMode: multiple` — many controllers may be added. Network
 * auto-discovery is not implemented; the controller is added by host.
 */
export class UnifiProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-unifi'
  protected readonly providerName = 'UniFi Network'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Hub]: UnifiControllerDevice,
    [DeviceType.Container]: UnifiInfraDevice,
    [DeviceType.Switch]: UnifiFeatureDevice,
    [DeviceType.Button]: UnifiFeatureDevice,
    [DeviceType.Sensor]: UnifiFeatureDevice,
    [DeviceType.Presence]: UnifiFeatureDevice,
  }

  constructor() {
    super({})
  }

  // ── No network auto-discovery for the controller itself ─────────────────────

  override async supportsDiscovery(): Promise<boolean> {
    return false
  }

  // ── Manual creation: a controller is added as a Hub device ──────────────────

  override async supportsManualCreation(): Promise<boolean> {
    return true
  }

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    // Only the controller is manually creatable; its infra + client children are
    // spawned by the controller's `device-discovery` adopt flow.
    if (type !== DeviceType.Hub) return null
    return buildControllerFormSchema()
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    if (type !== DeviceType.Hub) {
      throw new Error(`UniFi provider does not support device type: ${type}`)
    }
    const name = typeof config['name'] === 'string' ? config['name'].trim() : ''
    if (!name) throw userError('unifi.name-required', undefined, 'Controller name is required')

    const connection = extractConnection(config)
    if (connection.host.trim().length === 0) {
      throw userError('unifi.host-required', undefined, 'Controller host is required')
    }

    // Build the live client ONCE here so the controller device adopts a warm
    // client. With no library wired, `start()` throws — caught + logged, the
    // device is kept so the row persists for when the library lands.
    const stableId = this.generateStableId(DeviceType.Hub, { connection })
    const manager = new UnifiIntegrationManager({
      id: stableId,
      name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: (controllerId) => unifiControllers.emitSnapshot(controllerId),
    })
    unifiControllers.set(stableId, manager)
    try {
      await manager.start()
    } catch (err) {
      this.ctx.logger.warn('UniFi create: initial client connect failed — device kept', {
        meta: { stableId, error: errMsg(err) },
      })
    }

    return {
      meta: { type: DeviceType.Hub, name },
      config: { connection, system: 'unifi-controller' },
      onAfterCreate: async (device: IDevice) => {
        if (device instanceof UnifiControllerDevice) {
          device.adoptManager(manager)
        }
      },
    }
  }

  /**
   * Controller stableId — derived from the connection host + site (Reolink-style
   * identity key). Re-adding the same controller reuses its persisted row.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const connection = readConnection(config)
    const host = connection?.host.trim() ?? ''
    if (host.length > 0) {
      const site = connection?.site.trim() ?? 'default'
      return `unifi:${slugifyHost(host)}:${slugifyHost(site)}`
    }
    throw new Error(
      'UniFi: controller resolved no host endpoint — cannot persist a stable row key.',
    )
  }
}

/** Narrow the create-spec / stable-id config's `connection` to a validated config. */
function extractConnection(config: Record<string, unknown>): UnifiConnectionConfig {
  return settingsToConnection(config['connection'] ?? config)
}

/** Best-effort connection read for `generateStableId` (no throw on partial input). */
function readConnection(config: Record<string, unknown> | undefined): UnifiConnectionConfig | null {
  if (config === undefined) return null
  const raw = config['connection'] ?? config
  const parsed = unifiConnectionSchema.safeParse(typeof raw === 'object' && raw !== null ? raw : {})
  return parsed.success ? parsed.data : null
}
