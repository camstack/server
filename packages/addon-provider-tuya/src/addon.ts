import { TuyaCloud } from '@apocaliss92/nodetuya'
import {
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  connectionTestCapability,
  type DeviceConstructor,
  DeviceType,
  deviceAdoptionCapability,
  EventCategory,
  errMsg,
  type IConnectionTestProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type ProviderRegistration,
  type SystemEvent,
} from '@camstack/types'
import { buildConnectionFormSchema, connectionFromSettings, toTuyaCloudOptions } from './config.js'
import { TuyaKettleContainerDevice } from './devices/tuya-kettle-container-device.js'
import { TuyaSwitchDevice } from './devices/tuya-switch-device.js'
import { buildTuyaAdoptionProvider } from './tuya-adoption-provider.js'
import { TuyaClientRegistry } from './tuya-client-registry.js'
import { buildTuyaConnectionTestProvider } from './tuya-connection-test.js'
import { classifyTuyaCategory, deviceTypeForKind } from './tuya-dp-mapping.js'
import { type TuyaCatalogEntry, tuyaConnections } from './tuya-gateway.js'

/**
 * Tuya / Smart Life device-provider addon — `mode: account` (multi-account,
 * broker-less).
 *
 * Onboarding is CLOUD: each integration carries its own Tuya IoT-project
 * credentials in `integration.settings`; the addon holds one
 * {@link import('./tuya-integration-manager.js').TuyaIntegrationManager} per
 * `integrationId` in {@link TuyaClientRegistry}, which fetches the account's
 * device list + localKeys and publishes the CATALOG on the shared
 * {@link tuyaConnections} resolver. Ongoing CONTROL is LOCAL: each adopted device
 * owns a single `@apocaliss92/nodetuya` LAN client keyed by
 * `(integrationId, deviceId)`; a kettle Container's per-DP children share that
 * one connection.
 *
 * A `device-adoption` cap provider enumerates each account's cloud devices;
 * adopting one materialises either a {@link DeviceType.Switch} (raw on/off) or a
 * {@link DeviceType.Container} kettle that fans out its per-DP entities.
 * `hub-only`.
 */
export class TuyaProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-tuya'
  protected readonly providerName = 'Tuya'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Switch]: TuyaSwitchDevice,
    [DeviceType.Container]: TuyaKettleContainerDevice,
  }

  private clients: TuyaClientRegistry | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    this.clients = new TuyaClientRegistry(this.ctx.logger, tuyaConnections)
    this.clients.setOnConnected((integrationId) => {
      this.ctx.logger.info('Tuya: integration connected', { meta: { integrationId } })
    })
    this.clients.setOnDisconnected((integrationId) => {
      this.ctx.logger.debug('Tuya: integration disconnected', { meta: { integrationId } })
    })

    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()

    this.ctx.logger.info('Tuya: provider initialised', {
      meta: { integrationCount: this.requireClients().size() },
    })

    return [
      ...regs,
      { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
      { capability: connectionTestCapability, provider: this.buildConnectionTestProvider() },
    ]
  }

  /**
   * Pre-creation credential check. Registered unconditionally — it must answer
   * BEFORE any integration for this addon exists, so it depends on no live
   * client and opens its own throwaway session.
   */
  private buildConnectionTestProvider(): IConnectionTestProvider {
    return buildTuyaConnectionTestProvider({
      makeCloud: (config) => new TuyaCloud(toTuyaCloudOptions(config)),
      logger: this.ctx.logger,
    })
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Tuya: provider shutdown error', { meta: { error: errMsg(err) } })
    }
    this.clients = null
    tuyaConnections.clear()
    await super.onShutdown()
  }

  private requireClients(): TuyaClientRegistry {
    if (!this.clients) throw new Error('Tuya provider not initialised')
    return this.clients
  }

  /** Stable id, integration-scoped so two accounts exposing the same cloud
   *  device id don't collide. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = String(config?.['integrationId'] ?? 'unknown')
    const tuyaDeviceId = String(config?.['tuyaDeviceId'] ?? Date.now())
    return `tuya:${integrationId}:${tuyaDeviceId}`
  }

  // ── Per-integration credential reconcile ─────────────────────────────────

  private async reconcileIntegrations(): Promise<void> {
    const reg = this.requireClients()
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id && i.enabled)
      const surviving = new Set<string>()
      for (const integration of mine) {
        try {
          const settings = await this.ctx.api.integrations.getSettings.query({ id: integration.id })
          const connection = connectionFromSettings(settings)
          if (!connection) {
            this.ctx.logger.warn('Tuya integration has no complete credentials — skipping', {
              meta: { integrationId: integration.id },
            })
            continue
          }
          await reg.upsert(integration.id, integration.name, connection)
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('Tuya reconcile: failed to read integration settings', {
            meta: { integrationId: integration.id, error: errMsg(err) },
          })
        }
      }
      await reg.retain(surviving)
    } catch (err) {
      this.ctx.logger.warn('Tuya integration reconcile failed', { meta: { error: errMsg(err) } })
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

  // ── device-adoption cap provider ─────────────────────────────────────────

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildTuyaAdoptionProvider({
      logger: this.ctx.logger,
      getCatalog: (integrationId) => tuyaConnections.catalog(integrationId),
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      listAdoptedTuya: async () => {
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
      adoptDevice: async ({ entry, integrationId, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('tuya adopt: kernel.devices unavailable')
        const kind = classifyTuyaCategory(entry.category)
        const type = deviceTypeForKind(kind)
        const DeviceClass: DeviceConstructor<IDevice> =
          kind === 'kettle' ? TuyaKettleContainerDevice : TuyaSwitchDevice
        const config = this.buildDeviceConfig(entry, integrationId, name)
        const stableId = this.generateStableId(type, config)
        const device = await devices.create(stableId, DeviceClass, config, null, {
          type,
          name,
          integrationId,
        })
        const children = await devices.getChildren(device.id)
        return { deviceId: device.id, accessoryDeviceIds: children.map((c) => c.id) }
      },
      removeDevice: async (id) => {
        await this.ctx.kernel.devices?.remove(id)
      },
      findDeviceConfig: async (id) => {
        const devices = this.ctx.kernel.devices
        if (!devices) return null
        return devices.loadConfig(id).catch((): null => null)
      },
    })
  }

  /** Build the persisted control config for a newly-adopted device from its cloud
   *  catalog entry (localKey / host / version are the LAN-control SETTINGS). */
  private buildDeviceConfig(
    entry: TuyaCatalogEntry,
    integrationId: string,
    name: string,
  ): Record<string, unknown> {
    return {
      integrationId,
      tuyaDeviceId: entry.deviceId,
      localKey: entry.localKey,
      host: entry.ip,
      version: entry.version.length > 0 ? entry.version : '3.3',
      ...(entry.category !== undefined ? { category: entry.category } : {}),
      system: 'tuya',
      name,
    }
  }

  // ── Config form (account credentials, rendered by the wizard) ────────────

  protected override globalSettingsSchema(): ConfigUISchema {
    return buildConnectionFormSchema()
  }

  // ── Manual creation: not supported (devices are adopted from the cloud) ──

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
    throw new Error('Tuya devices are adopted from the cloud, not created manually')
  }
}
