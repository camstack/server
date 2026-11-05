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
import { UNIFI_SYSTEM } from './config.js'
import { UnifiFeatureDevice } from './devices/unifi-feature-device.js'
import { UnifiGatewayDevice } from './devices/unifi-gateway-device.js'
import { UnifiInfraDevice } from './devices/unifi-infra-device.js'
import { buildUnifiAdoptionProvider } from './unifi-adoption-provider.js'
import { liveUnifiClientFactory } from './unifi-client-live.js'
import { UnifiClientRegistry } from './unifi-client-registry.js'
import { buildUnifiDeviceAdopter } from './unifi-device-adopter.js'
import { unifiStableId } from './unifi-discovery.js'
import { reconcileInfraFeatures } from './unifi-feature-reconcile.js'
import { UnifiReconciler, type IntegrationLifecycleKind } from './unifi-reconciler.js'
import { cascadeRemoveDevicesForIntegration } from './unifi-integration-device-cascade.js'
import { setIntegrationDevicesOnline } from './unifi-integration-offline.js'
import {
  buildUnifiInstances,
  unifiConnectionOf,
  unifiConnectionsEntryKind,
  type UnifiConnectionBody,
  unifiRecordKinds,
} from './unifi-instances.js'
import { unifiControllers } from './unifi-node-resolver.js'

/** The date of the integration-rows-to-record migration (D1007). */
const UNIFI_MIGRATIONS_DATE = '2026-11-05'

/**
 * UniFi Network device-provider addon, `mode: account` and broker-less. An integration is one
 * controller: its host, port, credentials (an API key or a username + password, keychain
 * secrets), site and poll interval live on the integration's settings, and the addon polls it
 * with one client per `integrationId`. Discovery offers the controller itself
 * ({@link DeviceType.Gateway}, with a link to its UI), each infra device
 * ({@link DeviceType.Container}, fanning per-port PoE, restart, LED and sensors out as
 * accessory children) and each network client ({@link DeviceType.Presence}), all as siblings.
 * Cameras are not in scope.
 *
 * NOTE: no UniFi controller-API client library is wired yet (see `plan-unifi.md`): the
 * integration manager's default factory throws, so an integration installs cleanly but stays
 * offline. Everything else (config, discovery flow, cap surfaces) is complete and type-checked.
 *
 * `instanceMode: multiple` — many controllers may be added. Network auto-discovery is not
 * implemented; the controller is added by host.
 */
export class UnifiProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-unifi'
  protected readonly providerName = 'UniFi Network'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Gateway]: UnifiGatewayDevice,
    [DeviceType.Container]: UnifiInfraDevice,
    [DeviceType.Switch]: UnifiFeatureDevice,
    [DeviceType.Button]: UnifiFeatureDevice,
    [DeviceType.Sensor]: UnifiFeatureDevice,
    [DeviceType.Presence]: UnifiFeatureDevice,
  }

  private integrationReconciler: UnifiReconciler | null = null
  private clients: UnifiClientRegistry | null = null
  private instances: RecordIntegrationInstances<UnifiConnectionBody> | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined)
      throw new Error('provider-unifi: ctx.records is required (hub-only addon)')
    await records.declare(unifiRecordKinds)
    await this.runMigrations(
      defineAddonMigrations(
        [
          integrationRowsMigration({
            addonId: this.addonId,
            date: UNIFI_MIGRATIONS_DATE,
            kind: unifiConnectionsEntryKind,
            fixtureMark: 'host',
          }),
        ],
        integrationRowsPortsOver({
          api: defaultIntegrationApiOver(this.ctx.api),
          secrets: this.ctx.secrets ?? null,
          records,
          kind: unifiConnectionsEntryKind,
          warn: (message) => this.ctx.logger.warn(message),
        }),
      ),
    )
    this.instances = buildUnifiInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
    })
    this.clients = new UnifiClientRegistry(this.ctx.logger, {
      onConnected: (integrationId) => this.setIntegrationDevicesOnline(integrationId, true),
      onDisconnected: (integrationId) => this.setIntegrationDevicesOnline(integrationId, false),
      onPolled: (integrationId) => this.handlePolled(integrationId),
      makeClient: liveUnifiClientFactory,
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
      this.ctx.logger.warn('UniFi shutdown error', { meta: { error: errMsg(err) } })
    }
    this.clients = null
    this.integrationReconciler?.dispose()
    this.integrationReconciler = null
    unifiControllers.clear()
    await super.onShutdown()
  }

  private requireInstances(): RecordIntegrationInstances<UnifiConnectionBody> {
    if (!this.instances) throw new Error('UniFi provider not initialised')
    return this.instances
  }

  private requireClients(): UnifiClientRegistry {
    if (!this.clients) throw new Error('UniFi provider not initialised')
    return this.clients
  }

  /** Every device of an integration: `unifi:<integrationId>:<childNativeId>`. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = config?.['integrationId']
    const childNativeId = config?.['childNativeId']
    if (typeof integrationId !== 'string' || integrationId.length === 0) {
      throw new Error('unifi generateStableId: integrationId required')
    }
    if (typeof childNativeId !== 'string' || childNativeId.length === 0) {
      throw new Error('unifi generateStableId: childNativeId required')
    }
    return unifiStableId(integrationId, childNativeId)
  }

  /**
   * Upsert one client per enabled integration and drop the client of one the list ANSWERED is
   * gone. Never removes a device (D49): that follows only an explicit lifecycle event.
   * Idempotent; runs at boot and on every integration lifecycle event.
   */
  private reconciler(): UnifiReconciler {
    this.integrationReconciler ??= new UnifiReconciler({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      clients: this.requireClients(),
      listIntegrations: () => this.ctx.api.integrations.list.query(),
      applySettings: async (integration) => {
        const reg = this.requireClients()
        const read = await unifiConnectionOf(this.requireInstances(), integration.id)
        if (read === null) return false
        await reg.upsert(integration.id, integration.name, read.connection, read.credentialsLocked)
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
        return cfg['system'] === UNIFI_SYSTEM && typeof owner === 'string' ? owner : null
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

  /** On each poll tick: fan the snapshot out to the devices, and reconcile the infra features. */
  private handlePolled(integrationId: string): void {
    unifiControllers.emitSnapshot(integrationId)
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    void reconcileInfraFeatures({
      reg,
      devices,
      addonId: this.addonId,
      integrationId,
      logger: this.ctx.logger,
    }).catch((err) => {
      this.ctx.logger.warn('UniFi feature reconcile failed', {
        meta: { integrationId, error: errMsg(err) },
      })
    })
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    const adopter = () => {
      const devices = this.ctx.kernel.devices
      if (!devices) throw new Error('unifi adopt: kernel.devices unavailable')
      return buildUnifiDeviceAdopter({ devices })
    }
    return buildUnifiAdoptionProvider({
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      integrationName: (integrationId) => unifiControllers.getManager(integrationId)?.name ?? null,
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
      adoptInfra: async (input) => adopter().adoptInfra(input),
      adoptClient: async (input) => adopter().adoptClient(input),
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
    throw new Error('UniFi devices are adopted from the integration')
  }

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const n = setIntegrationDevicesOnline(reg.getAllForAddon(this.addonId), integrationId, online)
    if (n > 0) {
      this.ctx.logger.info('UniFi integration devices ' + (online ? 'online' : 'offline'), {
        meta: { integrationId, count: n },
      })
    }
  }
}
