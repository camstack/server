import {
  type AddonInitResult,
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
  integrationInstancesCapability,
  integrationRowsMigration,
  integrationRowsPortsOver,
  type RecordIntegrationInstances,
  type SystemEvent,
  collectOwnerIntegrationIds,
  defaultIntegrationApiOver,
  defineAddonMigrations,
} from '@camstack/types'
import { ENPAL_SYSTEM } from './config.js'
import { EnpalEquipmentDevice } from './devices/enpal-equipment-device.js'
import { buildEnpalAdoptionProvider } from './enpal-adoption-provider.js'
import { EnpalClientRegistry } from './enpal-client-registry.js'
import {
  buildEnpalInstances,
  enpalConnectionOf,
  enpalConnectionsEntryKind,
  type EnpalConnectionBody,
  enpalRecordKinds,
} from './enpal-instances.js'
import { EnpalReconciler, type IntegrationLifecycleKind } from './enpal-reconciler.js'
import { cascadeRemoveDevicesForIntegration } from './enpal-integration-device-cascade.js'
import { EnpalGatewayDevice } from './devices/enpal-gateway-device.js'
import { ENPAL_BOX_ID } from './enpal-discovery.js'
import { setIntegrationDevicesOnline } from './enpal-integration-offline.js'
import { enpalConnections } from './enpal-resolver.js'

/** The date of the integration-rows-to-record migration (D1007). */
const ENPAL_MIGRATIONS_DATE = '2026-11-05'

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

  private integrationReconciler: EnpalReconciler | null = null
  private clients: EnpalClientRegistry | null = null
  private instances: RecordIntegrationInstances<EnpalConnectionBody> | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined)
      throw new Error('provider-enpal: ctx.records is required (hub-only addon)')
    await records.declare(enpalRecordKinds)
    await this.runMigrations(
      defineAddonMigrations(
        [
          integrationRowsMigration({
            addonId: this.addonId,
            date: ENPAL_MIGRATIONS_DATE,
            kind: enpalConnectionsEntryKind,
            fixtureMark: 'host',
          }),
        ],
        integrationRowsPortsOver({
          api: defaultIntegrationApiOver(this.ctx.api),
          secrets: this.ctx.secrets ?? null,
          records,
          kind: enpalConnectionsEntryKind,
          warn: (message) => this.ctx.logger.warn(message),
        }),
      ),
    )
    this.instances = buildEnpalInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
    })
    this.clients = new EnpalClientRegistry(this.ctx.logger, {
      onConnected: (integrationId) => this.setIntegrationDevicesOnline(integrationId, true),
      onDisconnected: (integrationId) => this.setIntegrationDevicesOnline(integrationId, false),
    })
    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()
    return {
      providers: [
        ...regs,
        {
          capability: deviceAdoptionCapability,
          provider: this.buildAdoptionProvider(),
        },
        {
          capability: integrationInstancesCapability,
          provider: this.requireInstances().toProvider(),
        },
      ],
    }
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
    this.integrationReconciler?.dispose()
    this.integrationReconciler = null
    enpalConnections.clear()
    await super.onShutdown()
  }

  private requireInstances(): RecordIntegrationInstances<EnpalConnectionBody> {
    if (!this.instances) throw new Error('Enpal provider not initialised')
    return this.instances
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
   * Upsert one client per enabled integration and drop the client of one the list ANSWERED is
   * gone. Never removes a device (D49): that follows only an explicit lifecycle event.
   * Idempotent; runs at boot and on every integration lifecycle event.
   */
  private reconciler(): EnpalReconciler {
    this.integrationReconciler ??= new EnpalReconciler({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      clients: this.requireClients(),
      listIntegrations: () => this.ctx.api.integrations.list.query(),
      applySettings: async (integration) => {
        const reg = this.requireClients()
        const read = await enpalConnectionOf(this.requireInstances(), integration.id)
        if (read === null) return false
        await reg.upsert(integration.id, integration.name, read.connection, read.tokenLocked)
        return true
      },
      removeDevices: (integrationId) => this.cascadeRemoveDevicesForIntegration(integrationId),
      ownerIntegrationIds: () => this.ownerIntegrationIds(),
    })
    return this.integrationReconciler
  }

  private async reconcileIntegrations(): Promise<void> {
    await this.reconciler().reconcile()
  }

  /** Lifecycle events: only an explicit Deleted/Disabled naming an integration removes devices. */
  private subscribeIntegrationLifecycle(): void {
    const on =
      (kind: IntegrationLifecycleKind) =>
      (event: SystemEvent): void => {
        const addonId = event.data['addonId']
        if (typeof addonId === 'string' && addonId !== this.ctx.id) return
        const integrationId = event.data['integrationId']
        void this.reconciler().onLifecycle(
          kind,
          typeof integrationId === 'string' ? integrationId : null,
        )
      }
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, on('enabled'))
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, on('disabled'))
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, on('deleted'))
  }

  /** The integrations that own devices here, for the orphan sweep. */
  private async ownerIntegrationIds(): Promise<readonly string[]> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return []
    return await collectOwnerIntegrationIds({
      reg,
      devices,
      addonId: this.addonId,
      ownerOf: (cfg) => {
        const owner = cfg['integrationId']
        return cfg['system'] === ENPAL_SYSTEM && typeof owner === 'string' ? owner : null
      },
    })
  }

  private async cascadeRemoveDevicesForIntegration(integrationId: string): Promise<number> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return 0
    return await cascadeRemoveDevicesForIntegration({
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
