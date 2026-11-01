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
import { UnifiFeatureDevice } from './devices/unifi-feature-device.js'
import { UnifiGatewayDevice } from './devices/unifi-gateway-device.js'
import { UnifiInfraDevice } from './devices/unifi-infra-device.js'
import { buildUnifiAdoptionProvider } from './unifi-adoption-provider.js'
import { UnifiClientRegistry } from './unifi-client-registry.js'
import { buildUnifiDeviceAdopter } from './unifi-device-adopter.js'
import { unifiStableId } from './unifi-discovery.js'
import { reconcileInfraFeatures } from './unifi-feature-reconcile.js'
import { cascadeRemoveDevicesForIntegration } from './unifi-integration-device-cascade.js'
import { setIntegrationDevicesOnline } from './unifi-integration-offline.js'
import { unifiControllers } from './unifi-node-resolver.js'

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

  private clients: UnifiClientRegistry | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    this.clients = new UnifiClientRegistry(this.ctx.logger, {
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
      this.ctx.logger.warn('UniFi shutdown error', { meta: { error: errMsg(err) } })
    }
    this.clients = null
    unifiControllers.clear()
    await super.onShutdown()
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
            this.ctx.logger.warn('UniFi integration has no controller host — skipping', {
              meta: { integrationId: integration.id },
            })
            continue
          }
          await reg.upsert(
            integration.id,
            integration.name,
            read.connection,
            read.credentialsLocked,
          )
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('UniFi reconcile failed for integration', {
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
      this.ctx.logger.warn('UniFi integration reconcile failed', {
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
