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
import { buildConnectionFormSchema, connectionFromSettings, ENPAL_SYSTEM } from './config.js'
import { EnpalEquipmentDevice } from './devices/enpal-equipment-device.js'
import { buildEnpalAdoptionProvider } from './enpal-adoption-provider.js'
import { EnpalClientRegistry } from './enpal-client-registry.js'
import { cascadeRemoveDevicesForIntegration } from './enpal-integration-device-cascade.js'
import { EnpalGatewayDevice } from './devices/enpal-gateway-device.js'
import { ENPAL_BOX_ID } from './enpal-discovery.js'
import { setIntegrationDevicesOnline } from './enpal-integration-offline.js'
import { enpalConnections } from './enpal-resolver.js'

/**
 * Enpal solar box provider, `mode: account` and broker-less. An integration is one box: its
 * host, InfluxDB access and token live on the integration's settings, and the addon polls it
 * with one manager per `integrationId`. Discovery offers the box itself
 * ({@link DeviceType.Gateway}, with a link to its device page) and one
 * {@link DeviceType.Container} per piece of equipment it reports (photovoltaic, battery,
 * grid, house, heat pump), and adopting a container adopts its Sensor children.
 *
 * The box does not advertise itself on the network, so the integration is added by hand.
 */
export class EnpalProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-enpal'
  protected readonly providerName = 'Enpal'
  // The Sensor children are spawned by the Container's accessory specs, not restored here.
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: EnpalEquipmentDevice,
    [DeviceType.Gateway]: EnpalGatewayDevice,
  }

  private clients: EnpalClientRegistry | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    this.clients = new EnpalClientRegistry(this.ctx.logger, {
      onConnected: (integrationId) => this.setIntegrationDevicesOnline(integrationId, true),
      onDisconnected: (integrationId) => this.setIntegrationDevicesOnline(integrationId, false),
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
      this.ctx.logger.warn('Enpal shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.clients = null
    enpalConnections.clear()
    await super.onShutdown()
  }

  private requireClients(): EnpalClientRegistry {
    if (!this.clients) throw new Error('Enpal provider not initialised')
    return this.clients
  }

  /** One container per equipment per integration. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = config?.['integrationId']
    const equipment = config?.['equipment']
    if (typeof integrationId !== 'string' || integrationId.length === 0) {
      throw new Error('enpal generateStableId: integrationId required')
    }
    if (typeof equipment !== 'string' || equipment.length === 0) {
      throw new Error('enpal generateStableId: equipment required')
    }
    return `enpal:${integrationId}:${equipment}`
  }

  /**
   * Rebuild the pollers from the live integration list: upsert one per enabled integration
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
            this.ctx.logger.warn('Enpal integration has no box host — skipping', {
              meta: { integrationId: integration.id },
            })
            continue
          }
          await reg.upsert(integration.id, integration.name, read.connection, read.tokenLocked)
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('Enpal reconcile failed for integration', {
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
      this.ctx.logger.warn('Enpal integration reconcile failed', {
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

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildEnpalAdoptionProvider({
      getSnapshot: (integrationId) => enpalConnections.getSnapshot(integrationId),
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      integrationName: (integrationId) => enpalConnections.getManager(integrationId)?.name ?? null,
      listAdopted: async () => {
        const reg = this.ctx.kernel.deviceRegistry
        const devices = this.ctx.kernel.devices
        if (!reg || !devices) return []
        const out: { id: number; config: Record<string, unknown> }[] = []
        for (const d of reg.getAllForAddon(this.addonId)) {
          if (d.parentDeviceId !== null) continue
          const config = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
          out.push({ id: d.id, config })
        }
        return out
      },
      adoptDevice: async ({ equipment, specIds, integrationId, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('enpal adopt: kernel.devices unavailable')
        const config = {
          equipment,
          specIds,
          integrationId,
          system: ENPAL_SYSTEM,
        }
        const stableId = this.generateStableId(DeviceType.Container, config)
        const device = await devices.create(stableId, EnpalEquipmentDevice, config, null, {
          type: DeviceType.Container,
          name,
          integrationId,
        })
        const children = await devices.getChildren(device.id)
        return {
          deviceId: device.id,
          accessoryDeviceIds: children.map((c) => c.id),
        }
      },
      adoptGateway: async ({ integrationId, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('enpal adopt: kernel.devices unavailable')
        const config = { equipment: ENPAL_BOX_ID, integrationId, system: ENPAL_SYSTEM }
        const stableId = this.generateStableId(DeviceType.Gateway, config)
        const device = await devices.create(stableId, EnpalGatewayDevice, config, null, {
          type: DeviceType.Gateway,
          name,
          integrationId,
        })
        return { deviceId: device.id }
      },
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      findDeviceConfig: async (id) => {
        const devices = this.ctx.kernel.devices
        if (!devices) return null
        return devices.loadConfig(id).catch((): null => null)
      },
      logger: this.ctx.logger,
    })
  }

  /** The integration's settings form; the submitted values are stored per integration. */
  protected override globalSettingsSchema(): ConfigUISchema {
    return buildConnectionFormSchema()
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
    throw new Error('Enpal devices are adopted from the integration')
  }

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const n = setIntegrationDevicesOnline(reg.getAllForAddon(this.addonId), integrationId, online)
    if (n > 0) {
      this.ctx.logger.info('Enpal integration devices ' + (online ? 'online' : 'offline'), {
        meta: { integrationId, count: n },
      })
    }
  }
}
