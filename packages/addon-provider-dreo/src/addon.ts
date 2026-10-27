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
import { buildConnectionFormSchema, connectionFromSettings } from './config.js'
import { DreoContainerDevice } from './devices/dreo-container-device.js'
import { buildDreoAdoptionProvider } from './dreo-adoption-provider.js'
import { DreoClientRegistry } from './dreo-client-registry.js'
import { buildDreoConnectionTestProvider } from './dreo-connection-test.js'
import { dreoConnections } from './dreo-gateway.js'
import { cascadeRemoveDevicesForIntegration } from './dreo-integration-device-cascade.js'
import { defaultFacade } from './dreo-integration-manager.js'
import { type OfflineTarget, setIntegrationDevicesOnline } from './dreo-integration-offline.js'
import { dreoSession } from './dreo-session.js'

/**
 * Dreo device-provider addon — `mode: account` (multi-account, broker-less).
 *
 * Wraps the `@apocaliss92/nodedreo` Dreo cloud client (REST + WebSocket). Each
 * Dreo integration carries its own account credentials in its
 * `integration.settings`; the addon holds one {@link DreoIntegrationManager} per
 * `integrationId` in {@link DreoClientRegistry} (`Map<integrationId, manager>`).
 * There is NO shared broker. The live connection surface each manager owns
 * (discovery info + per-device handles) is published on the in-process
 * {@link dreoConnections} resolver KEYED BY `integrationId`.
 *
 * A `device-adoption` cap provider enumerates each account's cloud devices and
 * adopts them; each adopted cloud device becomes a {@link DeviceType.Container}
 * parent that fans out a single typed accessory child (fan / purifier / heater /
 * humidifier) and its entity children. The device classes resolve their live
 * handle by the `brokerId` config field — UNCHANGED device-side code; that field
 * now holds the integrationId (see the migration note in the addon docs).
 *
 * Placement: hub-only — the Dreo cloud is reached over outbound HTTPS + a
 * persistent WebSocket from a single account session; no LAN proximity matters,
 * so (like Dreame) the connection lives on the hub.
 */
export class DreoProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-dreo'
  protected readonly providerName = 'Dreo'
  // Container is the parent class for the accessory-children model; the typed
  // children are spawned via the Container's getAccessoryChildren() and restored
  // by the default Pass-2 "accessory, skip" path.
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: DreoContainerDevice,
  }

  private clients: DreoClientRegistry | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    dreoSession.bind({ logger: this.ctx.logger, getAlerts: () => this.ctx.api.alerts })
    this.clients = new DreoClientRegistry(this.ctx.logger)
    this.clients.setOnConnected((integrationId) => {
      this.ctx.logger.info('Dreo: integration connected', { meta: { integrationId } })
      this.setIntegrationDevicesOnline(integrationId, true)
    })
    this.clients.setOnDisconnected((integrationId) => {
      this.setIntegrationDevicesOnline(integrationId, false)
    })

    // reconcileIntegrations awaits each manager's login + discovery + connect,
    // so the connection surfaces are up (and discoverable for adoption) once
    // init completes.
    await this.reconcileIntegrations()
    this.subscribeIntegrationLifecycle()

    this.ctx.logger.info('Dreo: provider initialised', {
      meta: { integrationCount: this.requireClients().size() },
    })

    return [
      ...regs,
      { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
      { capability: connectionTestCapability, provider: this.buildConnectionTestProvider() },
    ]
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.clients?.shutdown()
    } catch (err) {
      this.ctx.logger.warn('Dreo: provider shutdown error', { meta: { error: errMsg(err) } })
    }
    this.clients = null
    dreoSession.unbind()
    await super.onShutdown()
  }

  private requireClients(): DreoClientRegistry {
    if (!this.clients) throw new Error('Dreo provider not initialised')
    return this.clients
  }

  /**
   * Stable id, integration-scoped so two accounts exposing the same cloud device
   * id don't collide. `brokerId` in the config is the integrationId (unchanged
   * field name).
   */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const integrationId = String(config?.['brokerId'] ?? 'unknown')
    const dreoDeviceId = String(config?.['dreoDeviceId'] ?? Date.now())
    return `dreo:${integrationId}:${dreoDeviceId}`
  }

  // ── Per-integration credential reconcile (mirrors Dreame / Wyze) ────────

  /**
   * Rebuild the `Map<integrationId, manager>` from the live integration list:
   * for each surviving Dreo integration read its settings and upsert a manager
   * (session-preserving if credentials are unchanged); drop managers whose
   * integration was deleted/disabled — cascade-removing their adopted devices.
   * Idempotent; runs on boot + on every integration lifecycle event. Guarded so
   * a failure never fails init.
   */
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
            this.ctx.logger.warn('Dreo integration has no complete credentials — skipping', {
              meta: { integrationId: integration.id },
            })
            continue
          }
          await reg.upsert(integration.id, integration.name, connection)
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('Dreo reconcile: failed to read integration settings', {
            meta: { integrationId: integration.id, error: errMsg(err) },
          })
        }
      }
      // Drop managers for integrations that vanished, and cascade-remove any
      // devices they had adopted (mirrors the old integration→broker cleanup).
      const vanished = reg.list().filter((id) => !surviving.has(id))
      await reg.retain(surviving)
      for (const integrationId of vanished) {
        await dreoSession.forget(integrationId)
        await this.cascadeRemoveDevicesForIntegration(integrationId)
      }
    } catch (err) {
      this.ctx.logger.warn('Dreo integration reconcile failed', {
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

  // ── connection-test cap provider ───────────────────────────────────────

  /**
   * Pre-creation credential check. Registered unconditionally — it must answer
   * BEFORE any integration for this addon exists, so it depends on nothing in
   * {@link DreoClientRegistry} and opens its own throwaway session.
   */
  private buildConnectionTestProvider(): IConnectionTestProvider {
    return buildDreoConnectionTestProvider({
      makeFacade: defaultFacade,
      logger: this.ctx.logger,
    })
  }

  // ── device-adoption cap provider ───────────────────────────────────────

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildDreoAdoptionProvider({
      registry: dreoConnections,
      logger: this.ctx.logger,
      hasIntegration: (integrationId) => this.requireClients().has(integrationId),
      listIntegrations: () => this.requireClients().list(),
      listAdoptedDreo: async () => {
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
      adoptDevice: async ({ dreoDeviceId, integrationId, name, model }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('dreo adopt: kernel.devices unavailable')
        // `brokerId` holds the integrationId (unchanged device-side field name)
        // so the device classes resolve their surface via dreoConnections by this id.
        const config = {
          dreoDeviceId,
          brokerId: integrationId,
          model,
          system: 'dreo',
          integrationId,
          name,
        }
        const stableId = this.generateStableId(DeviceType.Container, config)
        const device = await devices.create(stableId, DreoContainerDevice, config, null, {
          type: DeviceType.Container,
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

  // ── Config form (account credentials, rendered by the wizard) ───────────
  //
  // `mode: account`: the wizard's config step fetches this schema via
  // `addonSettings.getGlobalSettings` (which hydrates `globalSettingsSchema`)
  // and renders the account form. The SUBMITTED values are stored
  // PER-INTEGRATION (`integrations.create({ addonId, name, settings })`) — the
  // addon reads creds from `integration.settings`, NOT a global store. The
  // global schema is only a form carrier here.

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
    throw new Error('Dreo devices are adopted from the cloud, not created manually')
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  private setIntegrationDevicesOnline(integrationId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const devices: ReadonlyArray<OfflineTarget> = reg.getAllForAddon(this.addonId)
    const n = setIntegrationDevicesOnline(devices, integrationId, online)
    if (n > 0) {
      this.ctx.logger.info('Dreo: integration devices ' + (online ? 'online' : 'offline'), {
        meta: { integrationId, count: n },
      })
    }
  }
}
