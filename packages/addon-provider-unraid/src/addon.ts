import {
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  DeviceType,
  deviceAdoptionCapability,
  errMsg,
  EventCategory,
  type IDevice,
  type IDeviceAdoptionProvider,
  type ProviderRegistration,
  type SystemEvent,
} from '@camstack/types'
import { buildConnectionFormSchema, connectionFromSettings } from './config.js'
import { UnraidEntityDevice } from './devices/unraid-entity-device.js'
import { UnraidGatewayDevice } from './devices/unraid-gateway-device.js'
import { UnraidInstanceDevice } from './devices/unraid-instance-device.js'
import { buildUnraidAdoptionProvider } from './unraid-adoption-provider.js'
import { UnraidClientRegistry } from './unraid-client-registry.js'
import { buildUnraidDeviceAdopter } from './unraid-device-adopter.js'
import { unraidStableId } from './unraid-discovery.js'
import { reconcileInstanceEntities } from './unraid-entity-reconcile.js'
import { cascadeRemoveDevicesForIntegration } from './unraid-integration-device-cascade.js'
import { setIntegrationDevicesOnline } from './unraid-integration-offline.js'
import { unraidInstances } from './unraid-node-resolver.js'

/**
 * Unraid device-provider addon, `mode: account` and broker-less. An integration is one
 * server: its host, port and ADMIN-role API key (a keychain secret) live on the
 * integration's settings, and the addon polls it with one client per `integrationId`.
 * Discovery offers the server itself ({@link DeviceType.Gateway}, with a link to its
 * WebGUI) and its single instance {@link DeviceType.Container}, as siblings; the
 * Container fans array / disk / docker / notification entities out as accessory children.
 *
 * NOTE: the real `@apocaliss92/node-unraid` library EXISTS and is ready, but is
 * not wired here yet (see `plan-unraid.md`) — the integration manager's default
 * factory throws until it is installed + wired, so an integration installs
 * cleanly but stays offline. Everything else (config, discovery flow, entity
 * fan-out, cap surface) is complete and type-checked.
 *
 * `instanceMode: multiple` — many servers may be added. Network auto-discovery
 * is not implemented; the server is added by host.
 */
export class UnraidProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-unraid'
  protected readonly providerName = 'Unraid'
  // The entity children are spawned by the Container's accessory specs, not restored here.
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Gateway]: UnraidGatewayDevice,
    [DeviceType.Container]: UnraidInstanceDevice,
    [DeviceType.Sensor]: UnraidEntityDevice,
    [DeviceType.Switch]: UnraidEntityDevice,
    [DeviceType.Button]: UnraidEntityDevice,
    [DeviceType.EventEmitter]: UnraidEntityDevice,
  }

  private clients: UnraidClientRegistry | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    this.clients = new UnraidClientRegistry(this.ctx.logger, {
      onConnected: (integrationId) => this.setIntegrationDevicesOnline(integrationId, true),
      onDisconnected: (integrationId) => this.setIntegrationDevicesOnline(integrationId, false),
      onPolled: (integrationId) => this.handlePolled(integrationId),
    })
    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()
    return [
      ...regs,
      {
        capability: deviceAdoptionCapability,
        provider: this.buildAdoptionProvider(),
      },
    ]
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Unraid shutdown error', { meta: { error: errMsg(err) } })
    }
    this.clients = null
    unraidInstances.clear()
    await super.onShutdown()
  }

  private requireClients(): UnraidClientRegistry {
    if (!this.clients) throw new Error('Unraid provider not initialised')
    return this.clients
  }

  /** One Gateway and one Container per integration: `unraid:<integrationId>:<nativeId>`. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = config?.['integrationId']
    const nativeId = config?.['nativeId']
    if (typeof integrationId !== 'string' || integrationId.length === 0) {
      throw new Error('unraid generateStableId: integrationId required')
    }
    if (typeof nativeId !== 'string' || nativeId.length === 0) {
      throw new Error('unraid generateStableId: nativeId required')
    }
    return unraidStableId(integrationId, nativeId)
  }

  /**
   * Rebuild the clients from the live integration list: upsert one per enabled integration
   * with a host, drop the ones that vanished and cascade-remove their devices. Idempotent;
   * runs at boot and on every integration lifecycle event.
   */
  private async reconcileIntegrations(): Promise<void> {
    const reg = this.requireClients()
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id && i.enabled)
      const surviving = new Set<string>()
      for (const integration of mine) {
        try {
          const settings = await this.ctx.api.integrations.getSettings.query({
            id: integration.id,
          })
          const read = connectionFromSettings(settings)
          if (read === null) {
            this.ctx.logger.warn('Unraid integration has no server host — skipping', {
              meta: { integrationId: integration.id },
            })
            continue
          }
          await reg.upsert(integration.id, integration.name, read.connection, read.apiKeyLocked)
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('Unraid reconcile failed for integration', {
            meta: { integrationId: integration.id, error: errMsg(err) },
          })
        }
      }
      const vanished = reg.list().filter((id) => !surviving.has(id))
      await reg.retain(surviving)
      for (const integrationId of vanished) {
        await this.cascadeRemoveDevicesForIntegration(integrationId)
      }
    } catch (err) {
      this.ctx.logger.warn('Unraid integration reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private subscribeIntegrationLifecycle(): void {
    const handler = (event: SystemEvent): void => {
      const addonId = event.data['addonId']
      if (typeof addonId === 'string' && addonId !== this.ctx.id) return
      void this.reconcileIntegrations()
    }
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, handler)
  }

  private async cascadeRemoveDevicesForIntegration(integrationId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    await cascadeRemoveDevicesForIntegration({
      reg,
      devices,
      addonId: this.addonId,
      integrationId,
      logger: this.ctx.logger,
    })
  }

  /** On each poll tick: fan the snapshot out to the entities, and reconcile the Container. */
  private handlePolled(integrationId: string): void {
    unraidInstances.emitSnapshot(integrationId)
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    void reconcileInstanceEntities({
      reg,
      devices,
      addonId: this.addonId,
      integrationId,
      snapshot: unraidInstances.getSnapshot(integrationId),
      logger: this.ctx.logger,
    }).catch((err) => {
      this.ctx.logger.warn('Unraid entity reconcile failed', {
        meta: { integrationId, error: errMsg(err) },
      })
    })
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    const getSnapshot = (integrationId: string) => unraidInstances.getSnapshot(integrationId)
    const adopter = () => {
      const devices = this.ctx.kernel.devices
      if (!devices) throw new Error('unraid adopt: kernel.devices unavailable')
      return buildUnraidDeviceAdopter({ devices, getSnapshot })
    }
    return buildUnraidAdoptionProvider({
      getSnapshot,
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      integrationName: (integrationId) => unraidInstances.getManager(integrationId)?.name ?? null,
      listAdopted: async () => {
        const reg = this.ctx.kernel.deviceRegistry
        const kernelDevices = this.ctx.kernel.devices
        if (!reg || !kernelDevices) return []
        const out: { id: number; config: Record<string, unknown> }[] = []
        for (const d of reg.getAllForAddon(this.addonId)) {
          if (d.parentDeviceId !== null) continue
          const config = await kernelDevices
            .loadConfig(d.id)
            .catch((): Record<string, unknown> => ({}))
          out.push({ id: d.id, config })
        }
        return out
      },
      adoptGateway: async (input) => adopter().adoptGateway(input),
      adoptInstance: async (input) => adopter().adoptInstance(input),
      childDeviceIds: async (deviceId) => {
        const children = (await this.ctx.kernel.devices?.getChildren(deviceId)) ?? []
        return children.map((c) => c.id)
      },
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      findDeviceConfig: async (id) => {
        const kernelDevices = this.ctx.kernel.devices
        if (!kernelDevices) return null
        return kernelDevices.loadConfig(id).catch((): null => null)
      },
      logger: this.ctx.logger,
    })
  }

  /** The integration's settings form; the submitted values are stored per integration. */
  protected override globalSettingsSchema(): ConfigUISchema {
    return buildConnectionFormSchema()
  }

  override async supportsDiscovery(): Promise<boolean> {
    return false
  }

  override async supportsManualCreation(): Promise<boolean> {
    return false
  }

  protected async onGetCreationSchema(_type: DeviceType): Promise<ConfigUISchema | null> {
    return null
  }

  protected async onCreateDevice(
    _type: DeviceType,
    _config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    throw new Error('Unraid devices are adopted from the integration')
  }

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const n = setIntegrationDevicesOnline(reg.getAllForAddon(this.addonId), integrationId, online)
    if (n > 0) {
      this.ctx.logger.info('Unraid integration devices ' + (online ? 'online' : 'offline'), {
        meta: { integrationId, count: n },
      })
    }
  }
}
