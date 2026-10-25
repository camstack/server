import { userError } from '@camstack/types'
import {
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  type DeviceSummary,
  DeviceType,
  type DiscoveryCandidate,
  errMsg,
  type IDevice,
} from '@camstack/types'
import {
  buildConnectionFormSchema,
  buildDiscoveryParamsFormSchema,
  type GreeConfig,
  settingsToGreeConfig,
} from './config.js'
import { GreeContainerDevice } from './devices/gree-container-device.js'
import { greeConnections, macKey } from './gree-gateway.js'
import {
  bindOnce,
  discoverGreeDevices,
  GreeIntegrationManager,
} from './gree-integration-manager.js'

/**
 * Gree air-conditioner device-provider addon — `mode: standalone` (the Reolink /
 * Ecowitt pattern). No broker, no device-adoption cap. An AC is added as a DEVICE
 * via the manual-creation form: the CONNECTION (host IP + optional broadcastAddr
 * + UDP tuning) lives on the AC DEVICE config. `onCreateDevice` runs a DIRECTED
 * bind against the given host to learn the AC's durable identity (MAC) and prove
 * reachability, then creates a {@link GreeContainerDevice} that OWNS its own live
 * `@apocaliss92/nodegree` client and fans out its Thermostat + toggle accessory
 * children (climate-control with swing entities + the panel-light / X-Fan /
 * health / fresh-air switches — all preserved from the broker model).
 *
 * `instanceMode: multiple` — many ACs may be added. Placement: any-node — Gree is
 * LOCAL UDP; the addon runs on whichever node shares the AC's subnet.
 *
 * LAN UDP-broadcast auto-discovery is implemented via the `device-provider`
 * discovery surface (`supportsDiscovery`/`discoverDevices`/`adoptDiscoveredDevice`)
 * — the same one ONVIF uses and the aggregated "Scan network" modal fans out to.
 * Manual add-one-AC-by-IP (directed bind) remains available in parallel.
 */
export class GreeProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-gree'
  protected readonly providerName = 'Gree'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: GreeContainerDevice,
  }

  constructor() {
    super({})
  }

  // ── Discovery: LAN UDP broadcast scan ──────────────────────────────────

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async getDiscoveryParamsSchema(): Promise<ConfigUISchema | null> {
    return buildDiscoveryParamsFormSchema()
  }

  override async discoverDevices(input?: {
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    const broadcastAddress =
      typeof input?.params?.['broadcastAddress'] === 'string'
        ? input.params['broadcastAddress'].trim()
        : undefined
    const timeoutMs =
      typeof input?.params?.['timeoutMs'] === 'number' ? input.params['timeoutMs'] : undefined
    const responders = await discoverGreeDevices({
      ...(broadcastAddress ? { broadcastAddress } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
    })
    this.ctx.logger.info('Gree discovery complete', {
      meta: { count: responders.length, broadcastAddress: broadcastAddress ?? 'local' },
    })
    return responders.map((d) => {
      const displayName = d.name.length > 0 ? d.name : d.mac
      return {
        // Match generateStableId so a re-scan of an already-added AC is detected
        // as adopted and re-adding reuses its persisted row.
        stableId: `gree:${macKey(d.mac)}`,
        type: DeviceType.Container,
        suggestedName: displayName,
        prefilledConfig: {
          name: displayName,
          host: d.ip,
          ...(d.model !== undefined ? { model: d.model } : {}),
        },
      }
    })
  }

  override async adoptDiscoveredDevice(input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    // Reuse the manual-creation path: onCreateDevice runs the directed bind
    // against the discovered IP to learn the durable MAC identity.
    return this.createDevice({
      type: DeviceType.Container,
      config: input.candidate.prefilledConfig,
    })
  }

  // ── Manual creation: an AC is added as a Container device ───────────────

  override async supportsManualCreation(): Promise<boolean> {
    return true
  }

  protected async onGetCreationSchema(type: DeviceType): Promise<ConfigUISchema | null> {
    if (type !== DeviceType.Container) return null
    return buildConnectionFormSchema()
  }

  protected async onCreateDevice(
    type: DeviceType,
    config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    if (type !== DeviceType.Container) {
      throw new Error(`Gree provider does not support device type: ${type}`)
    }
    const name = typeof config['name'] === 'string' ? config['name'].trim() : ''
    if (!name) throw userError('gree.name-required', undefined, 'Air conditioner name is required')

    const connection = settingsToGreeConfig(config)
    if (connection.host.trim().length === 0) {
      throw userError('gree.ip-required', undefined, 'Air conditioner IP address is required')
    }

    // Directed bind: prove the AC is reachable + learn its durable MAC identity
    // BEFORE the device exists (so generateStableId can key on the MAC and the
    // Add modal surfaces a clear error if the AC does not respond).
    const bound = await bindOnce({ connection, logger: this.ctx.logger })

    const connectionKey = `gree:${macKey(bound.mac)}`
    const deviceConfig: Record<string, unknown> = {
      greeMac: macKey(bound.mac),
      greeIp: bound.ip,
      connectionKey,
      connection,
      system: 'gree',
      name,
    }

    // Start the live per-device client ONCE here so the device adopts a warm,
    // already-bound handle (mirrors the Ecowitt gateway reusing the create-time
    // client). The manager publishes the surface on `greeConnections`.
    const manager = new GreeIntegrationManager({
      id: connectionKey,
      name,
      connection,
      logger: this.ctx.logger,
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      surfaceSink: greeConnections,
      expectMac: bound.mac,
    })
    try {
      await manager.start()
    } catch (err) {
      this.ctx.logger.warn('Gree create: initial client start failed — device kept', {
        meta: { connectionKey, error: errMsg(err) },
      })
    }

    return {
      meta: { type: DeviceType.Container, name },
      config: deviceConfig,
      onAfterCreate: async (device: IDevice) => {
        if (device instanceof GreeContainerDevice) {
          device.adoptManager(manager)
        }
      },
    }
  }

  /**
   * AC stableId — derived from the AC's durable MAC identity (resolved by the
   * create-time bind), NOT a broker id. Re-adding the same physical AC reuses its
   * persisted row. Falls back to a timestamp only when no MAC is resolvable
   * (should not happen — `onCreateDevice` binds first).
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const mac = config?.['greeMac']
    if (typeof mac === 'string' && mac.length > 0) return `gree:${macKey(mac)}`
    return `gree:${Date.now()}`
  }
}

/** Re-exported so the connection form + parser are reachable from the barrel. */
export type { GreeConfig }
