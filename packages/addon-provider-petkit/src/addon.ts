import { isDualHopper as libIsDualHopper, Nodepetkit } from '@apocaliss92/nodepetkit'
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
import {
  buildConnectionFormSchema,
  connectionFromSettings,
  toNodepetkitOptions,
  toPetkitCredentials,
} from './config.js'
import { PetkitFeederDevice } from './devices/petkit-feeder-device.js'
import { buildPetkitAdoptionProvider } from './petkit-adoption-provider.js'
import { PetkitClientRegistry } from './petkit-client-registry.js'
import { buildPetkitConnectionTestProvider } from './petkit-connection-test.js'
import { petkitConnections } from './petkit-gateway.js'

/**
 * PetKit device-provider addon — `mode: account` (multi-account, broker-less).
 *
 * Wraps the `@apocaliss92/nodepetkit` PetKit cloud client. Each PetKit
 * integration carries its own account credentials in its `integration.settings`;
 * the addon holds one {@link PetkitIntegrationManager} per `integrationId` in
 * {@link PetkitClientRegistry}. The live feeder roster + handles each manager
 * owns are published on the in-process {@link petkitConnections} resolver keyed
 * by `integrationId`.
 *
 * A `device-adoption` cap provider enumerates each account's feeders and adopts
 * them; each adopted feeder becomes a single {@link DeviceType.PetFeeder} device
 * that registers the `pet-feeder` cap and resolves its live handle by
 * `(integrationId, petkitDeviceId)`. `hub-only`: PetKit is outbound HTTPS.
 */
export class PetkitProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-petkit'
  protected readonly providerName = 'PetKit'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.PetFeeder]: PetkitFeederDevice,
  }

  private clients: PetkitClientRegistry | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    this.clients = new PetkitClientRegistry(this.ctx.logger)
    this.clients.setOnConnected((integrationId) => {
      this.ctx.logger.info('PetKit: integration connected', { meta: { integrationId } })
      this.setIntegrationDevicesOnline(integrationId, true)
    })
    this.clients.setOnDisconnected((integrationId) => {
      this.setIntegrationDevicesOnline(integrationId, false)
    })

    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()

    this.ctx.logger.info('PetKit: provider initialised', {
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
    return buildPetkitConnectionTestProvider({
      makeFacade: (config) =>
        new Nodepetkit(toPetkitCredentials(config), toNodepetkitOptions(config)),
      logger: this.ctx.logger,
    })
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('PetKit: provider shutdown error', { meta: { error: errMsg(err) } })
    }
    this.clients = null
    await super.onShutdown()
  }

  private requireClients(): PetkitClientRegistry {
    if (!this.clients) throw new Error('PetKit provider not initialised')
    return this.clients
  }

  /**
   * Integration-scoped stable id so two accounts exposing the same PetKit device
   * id don't collide.
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = String(config?.['integrationId'] ?? 'unknown')
    const petkitDeviceId = String(config?.['petkitDeviceId'] ?? Date.now())
    return `petkit:${integrationId}:${petkitDeviceId}`
  }

  // ── Per-integration credential reconcile (mirrors Dreame) ────────────────

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
            this.ctx.logger.warn('PetKit integration has no complete credentials — skipping', {
              meta: { integrationId: integration.id },
            })
            continue
          }
          await reg.upsert(integration.id, integration.name, connection)
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('PetKit reconcile: failed to read integration settings', {
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
      this.ctx.logger.warn('PetKit integration reconcile failed', {
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

  /** Remove every adopted PetKit device belonging to a vanished integration. */
  private async cascadeRemoveDevicesForIntegration(integrationId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    for (const d of reg.getAllForAddon(this.addonId)) {
      const config = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
      if (config['system'] === 'petkit' && config['integrationId'] === integrationId) {
        try {
          await devices.remove(d.id)
        } catch (err) {
          this.ctx.logger.warn('PetKit cascade remove failed', {
            meta: { deviceId: d.id, integrationId, error: errMsg(err) },
          })
        }
      }
    }
  }

  // ── device-adoption cap provider ─────────────────────────────────────────

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildPetkitAdoptionProvider({
      logger: this.ctx.logger,
      getInfos: (integrationId) => petkitConnections.getInfos(integrationId),
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      listAdoptedPetkit: async () => {
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
      adoptDevice: async ({ petkitDeviceId, integrationId, petkitDeviceType, name, model }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('petkit adopt: kernel.devices unavailable')
        const config = {
          petkitDeviceId,
          integrationId,
          petkitDeviceType,
          isDualHopper: libIsDualHopper(petkitDeviceType),
          model,
          system: 'petkit',
          name,
        }
        const stableId = this.generateStableId(DeviceType.PetFeeder, config)
        const device = await devices.create(stableId, PetkitFeederDevice, config, null, {
          type: DeviceType.PetFeeder,
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
    })
  }

  // ── Config form (account credentials, rendered by the wizard) ────────────

  protected override globalSettingsSchema(): ConfigUISchema {
    return buildConnectionFormSchema()
  }

  // ── Manual creation: not supported (feeders are adopted from the cloud) ──

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
    throw new Error('PetKit feeders are adopted from the cloud, not created manually')
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    for (const d of reg.getAllForAddon(this.addonId)) {
      if (d.config.get('system') !== 'petkit') continue
      if (d.config.get('integrationId') !== integrationId) continue
      if (d.online === online) continue
      d.markOnline(online)
    }
  }
}
