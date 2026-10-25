import { Rademacher } from '@apocaliss92/noderademacher'
import {
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  DeviceType,
  type DeviceSummary,
  type DiscoveryCandidate,
  errMsg,
  type IDevice,
} from '@camstack/types'
import {
  buildConnectionFormSchema,
  type RademacherConnectionConfig,
  rademacherConnectionSchema,
  settingsToConnection,
  slugifyHost,
} from './config.js'
import { RademacherCoverDevice } from './devices/rademacher-cover-device.js'
import { RademacherHubDevice } from './devices/rademacher-hub-device.js'
import { rademacherHubs } from './rademacher-hub-resolver.js'
import { RademacherIntegrationManager } from './rademacher-integration-manager.js'

/**
 * Rademacher HomePilot device-provider addon — `mode: standalone` (the Reolink /
 * Ecowitt pattern). No broker, no device-adoption cap. A hub is added as a
 * DEVICE via the manual-creation form: the CONNECTION (host / password / base
 * path / poll interval) lives on the hub DEVICE config. The created hub is a
 * {@link DeviceType.Hub} ({@link RademacherHubDevice}) that owns its own live
 * `@apocaliss92/noderademacher` client and registers `device-discovery` to adopt
 * its own roller-shutter children as {@link DeviceType.Cover} devices.
 *
 * `instanceMode: multiple` — many hubs may be added.
 */
export class RademacherProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-rademacher'
  protected readonly providerName = 'Rademacher'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Hub]: RademacherHubDevice,
    [DeviceType.Cover]: RademacherCoverDevice,
  }

  constructor() {
    super({})
  }

  // ── Discovery: HomePilot HTTP/SSDP probe ───────────────────────────────────

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async discoverDevices(): Promise<readonly DiscoveryCandidate[]> {
    let hubs: Awaited<ReturnType<typeof Rademacher.discover>> = []
    try {
      hubs = await Rademacher.discover()
    } catch (err) {
      this.ctx.logger.warn('Rademacher discovery failed', { meta: { error: errMsg(err) } })
      return []
    }
    this.ctx.logger.info('Rademacher discovery complete', { meta: { count: hubs.length } })
    return hubs.map((hub) => {
      const displayName = hub.name.length > 0 ? hub.name : hub.model
      return {
        // Match generateStableId (`rademacher:<slug(host)>`) so a re-scan of an
        // already-added hub is detected as adopted and re-adding reuses its row.
        stableId: `rademacher:${slugifyHost(hub.host)}`,
        type: DeviceType.Hub,
        suggestedName: displayName,
        prefilledConfig: {
          name: displayName,
          connection: { host: hub.host, ...(hub.basePath ? { basePath: hub.basePath } : {}) },
        },
      }
    })
  }

  override async adoptDiscoveredDevice(input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    return this.createDevice({
      type: DeviceType.Hub,
      config: input.candidate.prefilledConfig,
    })
  }

  // ── Manual creation: a hub is added as a Hub device ─────────────────────────

  override async supportsManualCreation(): Promise<boolean> {
    return true
  }

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    // Only the hub is manually creatable; its cover children are spawned by the
    // hub's `device-discovery` adopt flow.
    if (type !== DeviceType.Hub) return null
    return buildConnectionFormSchema()
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    if (type !== DeviceType.Hub) {
      throw new Error(`Rademacher provider does not support device type: ${type}`)
    }
    const name = typeof config['name'] === 'string' ? config['name'].trim() : ''
    if (!name) throw new Error('Hub name is required')

    const connection = extractConnection(config)
    if (connection.host.trim().length === 0) {
      throw new Error('Hub host is required')
    }

    // Connect the live client ONCE here so the hub device adopts a warm client.
    const stableId = this.generateStableId(DeviceType.Hub, { connection })
    const manager = new RademacherIntegrationManager({
      id: stableId,
      name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onPolled: (hubId) => rademacherHubs.emitSnapshot(hubId),
    })
    rademacherHubs.set(stableId, manager)
    try {
      await manager.start()
    } catch (err) {
      this.ctx.logger.warn('Rademacher create: initial client connect failed — device kept', {
        meta: { stableId, error: errMsg(err) },
      })
    }

    return {
      meta: { type: DeviceType.Hub, name },
      config: { connection, system: 'rademacher-hub' },
      onAfterCreate: async (device: IDevice) => {
        if (device instanceof RademacherHubDevice) {
          device.adoptManager(manager)
        }
      },
    }
  }

  /**
   * Hub stableId — derived from the connection host (Reolink-style identity key),
   * NOT a broker id. Re-adding the same hub reuses its persisted row.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const connection = readConnection(config)
    const host = connection?.host.trim() ?? ''
    if (host.length > 0) return `rademacher:${slugifyHost(host)}`
    throw new Error('Rademacher: hub resolved no host endpoint — cannot persist a stable row key.')
  }
}

/** Narrow the create-spec / stable-id config's `connection` to a validated config. */
function extractConnection(config: Record<string, unknown>): RademacherConnectionConfig {
  return settingsToConnection(config['connection'] ?? config)
}

/** Best-effort connection read for `generateStableId` (no throw on partial input). */
function readConnection(
  config: Record<string, unknown> | undefined,
): RademacherConnectionConfig | null {
  if (config === undefined) return null
  const raw = config['connection'] ?? config
  const parsed = rademacherConnectionSchema.safeParse(
    typeof raw === 'object' && raw !== null ? raw : {},
  )
  return parsed.success ? parsed.data : null
}
