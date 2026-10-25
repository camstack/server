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
  type UnraidConnectionConfig,
  settingsToConnection,
  slugifyHost,
  unraidConnectionSchema,
} from './config.js'
import { UnraidHubDevice } from './devices/unraid-hub-device.js'
import { UnraidInstanceDevice } from './devices/unraid-instance-device.js'
import { UnraidEntityDevice } from './devices/unraid-entity-device.js'
import { unraidInstances } from './unraid-node-resolver.js'
import { UnraidIntegrationManager } from './unraid-integration-manager.js'

/**
 * Unraid device-provider addon — `mode: standalone` (the Reolink / Velux /
 * Ecowitt pattern). No broker, no device-adoption cap. A server is added as a
 * DEVICE via the manual-creation form: the CONNECTION (host / port / https /
 * apiKey / poll interval) lives on the instance Hub DEVICE config. The created
 * Hub is a {@link DeviceType.Hub} ({@link UnraidHubDevice}) that owns its own
 * live client and registers `device-discovery` to adopt exactly ONE
 * {@link DeviceType.Container} ({@link UnraidInstanceDevice}) — the instance —
 * which fans array / disk / docker / notification entities out as accessory
 * children.
 *
 * NOTE: the real `@apocaliss92/node-unraid` library EXISTS and is ready, but is
 * not wired here yet (see `plan-unraid.md`) — the integration manager's default
 * factory throws until it is installed + wired, so a created Hub installs
 * cleanly but stays offline. Everything else (config, discovery flow, entity
 * fan-out, cap surface) is complete and type-checked.
 *
 * `instanceMode: multiple` — many servers may be added. Network auto-discovery
 * is not implemented; the server is added by host.
 */
export class UnraidProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-unraid'
  protected readonly providerName = 'Unraid'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Hub]: UnraidHubDevice,
    [DeviceType.Container]: UnraidInstanceDevice,
    [DeviceType.Sensor]: UnraidEntityDevice,
    [DeviceType.Switch]: UnraidEntityDevice,
    [DeviceType.Button]: UnraidEntityDevice,
    [DeviceType.EventEmitter]: UnraidEntityDevice,
  }

  constructor() {
    super({})
  }

  // ── No network auto-discovery for the server itself ─────────────────────────

  override async supportsDiscovery(): Promise<boolean> {
    return false
  }

  // ── Manual creation: a server is added as a Hub device ──────────────────────

  override async supportsManualCreation(): Promise<boolean> {
    return true
  }

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    // Only the instance Hub is manually creatable; its Container + entity
    // children are spawned by the Hub's `device-discovery` adopt flow.
    if (type !== DeviceType.Hub) return null
    return buildConnectionFormSchema()
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    if (type !== DeviceType.Hub) {
      throw new Error(`Unraid provider does not support device type: ${type}`)
    }
    const name = typeof config['name'] === 'string' ? config['name'].trim() : ''
    if (!name) throw userError('unraid.name-required', undefined, 'Server name is required')

    const connection = extractConnection(config)
    if (connection.host.trim().length === 0) {
      throw userError('unraid.host-required', undefined, 'Server host is required')
    }

    // Build the live client ONCE here so the Hub device adopts a warm client.
    // With the lib not wired, `start()` throws — caught + logged, the device is
    // kept so the row persists for when the lib is wired.
    const stableId = this.generateStableId(DeviceType.Hub, { connection })
    const manager = new UnraidIntegrationManager({
      id: stableId,
      name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: (instanceId) => unraidInstances.emitSnapshot(instanceId),
    })
    unraidInstances.set(stableId, manager)
    try {
      await manager.start()
    } catch (err) {
      this.ctx.logger.warn('Unraid create: initial client connect failed — device kept', {
        meta: { stableId, error: errMsg(err) },
      })
    }

    return {
      meta: { type: DeviceType.Hub, name },
      config: { connection, system: 'unraid-hub' },
      onAfterCreate: async (device: IDevice) => {
        if (device instanceof UnraidHubDevice) {
          device.adoptManager(manager)
        }
      },
    }
  }

  /**
   * Instance stableId — derived from the connection host (Reolink-style identity
   * key). Re-adding the same server reuses its persisted row.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const connection = readConnection(config)
    const host = connection?.host.trim() ?? ''
    if (host.length > 0) return `unraid:${slugifyHost(host)}`
    throw new Error('Unraid: server resolved no host endpoint — cannot persist a stable row key.')
  }
}

/** Narrow the create-spec / stable-id config's `connection` to a validated config. */
function extractConnection(config: Record<string, unknown>): UnraidConnectionConfig {
  return settingsToConnection(config['connection'] ?? config)
}

/** Best-effort connection read for `generateStableId` (no throw on partial input). */
function readConnection(
  config: Record<string, unknown> | undefined,
): UnraidConnectionConfig | null {
  if (config === undefined) return null
  const raw = config['connection'] ?? config
  const parsed = unraidConnectionSchema.safeParse(
    typeof raw === 'object' && raw !== null ? raw : {},
  )
  return parsed.success ? parsed.data : null
}
