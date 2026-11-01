import type { Sensor } from '@apocaliss92/nodewitt'
import {
  BaseDeviceProvider,
  type ConfigUISchema,
  type CreateDeviceSpec,
  type DeviceConstructor,
  DeviceType,
  deviceAdoptionCapability,
  type DeviceRestoreReport,
  type DiscoveryCandidate,
  type DiscoveryHit,
  type DiscoveryMode,
  defineAddonMigrations,
  errMsg,
  EventCategory,
  type IDevice,
  type IDeviceAdoptionProvider,
  type ProviderRegistration,
  type SavedDevice,
  type SystemEvent,
  type DeviceSummary,
  userError,
} from '@camstack/types'
import {
  buildConnectionFormSchema,
  connectionFromSettings,
  ECOWITT_SYSTEM,
  gatewayKeyOf,
} from './config.js'
import { EcowittContainerDevice } from './devices/ecowitt-container-device.js'
import {
  ECOWITT_GATEWAY_DEVICE_KIND,
  EcowittGatewayDevice,
} from './devices/ecowitt-gateway-device.js'
import { buildEcowittAdoptionProvider } from './ecowitt-adoption-provider.js'
import { EcowittClientRegistry, ecowittConnections } from './ecowitt-client-registry.js'
import { gatewayDeviceNativeId } from './ecowitt-discovery.js'
import { ecowittFacades } from './ecowitt-gateway.js'
import {
  cascadeRemoveDevicesForIntegration,
  setGatewayDevicesOnline,
} from './ecowitt-integration-devices.js'
import {
  ECOWITT_DISCOVERY_MODES,
  ecowittCandidates,
  ecowittGatewaysFromHits,
  ecowittScanKey,
} from './ecowitt-lan-discovery.js'
import type { EcowittDeviceGroup } from './ecowitt-mapping.js'
import { bucketSensorsByGroup, configDeviceGroup, sensorsEqual } from './ecowitt-sensor-groups.js'
import { ADDON_MIGRATIONS, type EcowittMigrationPorts } from './migrations/index.js'

/**
 * Ecowitt weather-station provider, `mode: account` and broker-less. An integration is one
 * gateway: its transport, host/port, password (keychain) or listener port live on the
 * integration's settings, and the addon keeps one live `@apocaliss92/nodewitt` client per
 * integration. Discovery offers the gateway itself ({@link DeviceType.Gateway}, with a link to its
 * page) and up to THREE group {@link DeviceType.Container}s (gateway / weather-station /
 * temp-sensor-ch1), each fanning out one typed sensor child per `Sensor.quantity`.
 *
 * The old Hub device that held the connection is retired by the `provider-ecowitt` migration
 * (D987), run from {@link onRestoreDevices}: no Hub device exists any more.
 */
export class EcowittProviderAddon extends BaseDeviceProvider {
  protected readonly addonId = 'provider-ecowitt'
  protected readonly providerName = 'Ecowitt'
  // The Sensor children are spawned by the Container's accessory specs, not restored here.
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: EcowittContainerDevice,
    [DeviceType.Gateway]: EcowittGatewayDevice,
  }

  private clients: EcowittClientRegistry | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<ProviderRegistration[]> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    this.clients = new EcowittClientRegistry(this.ctx.logger, {
      onOnline: (_integrationId, gatewayKey, online) =>
        this.setGatewayDevicesOnline(gatewayKey, online),
      onSensors: (_integrationId, gatewayKey, sensors) =>
        this.handleSensorsChanged(gatewayKey, sensors),
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
      this.ctx.logger.warn('Ecowitt shutdown error', {
        meta: { error: errMsg(err) },
      })
    }
    this.clients = null
    ecowittFacades.clear()
    ecowittConnections.clear()
    await super.onShutdown()
  }

  private requireClients(): EcowittClientRegistry {
    if (!this.clients) throw new Error('Ecowitt provider not initialised')
    return this.clients
  }

  // ── Migration: the Hub device becomes an integration + Gateway sibling ──

  /**
   * The `provider-ecowitt` catalogue runs here because it needs the persisted rows. Its
   * procedure creates the integration, restores the Containers top-level and retires the Hub by
   * tombstone; whatever it restored is not restored a second time.
   */
  protected override async onRestoreDevices(
    savedDevices: readonly SavedDevice[],
  ): Promise<DeviceRestoreReport | void> {
    const restoredByMigration = new Set<number>()
    const ports = this.buildMigrationPorts(savedDevices, async (rows) => {
      await this.reconcileIntegrations()
      await super.onRestoreDevices(rows)
      for (const row of rows) restoredByMigration.add(row.id)
    })
    await this.runMigrations(defineAddonMigrations(ADDON_MIGRATIONS, ports))
    const rows = savedDevices.filter(
      (row) => row.type !== DeviceType.Hub && !restoredByMigration.has(row.id),
    )
    return super.onRestoreDevices(rows)
  }

  private buildMigrationPorts(
    saved: readonly SavedDevice[],
    restoreRows: (rows: readonly SavedDevice[]) => Promise<void>,
  ): EcowittMigrationPorts {
    const devices = this.ctx.kernel.devices
    if (!devices) throw new Error('ecowitt hub migration: kernel.devices unavailable')
    return {
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      listSavedDevices: async () => saved,
      restoreRows,
      listIntegrations: async () =>
        (await this.ctx.api.integrations.list.query()).map((i) => ({
          id: i.id,
          addonId: i.addonId,
          name: i.name,
          info: i.info,
          ...(i.originStableId !== undefined ? { originStableId: i.originStableId } : {}),
        })),
      createIntegration: async (input) => {
        const created = await this.ctx.api.integrations.create.mutate({
          addonId: input.addonId,
          name: input.name,
          info: { ...input.info },
          originStableId: input.originStableId,
          settings: { ...input.settings },
          secretKeys: [...input.secretKeys],
        })
        return { id: created.id }
      },
      setIntegrationId: async (deviceId, integrationId) => {
        await this.ctx.api.deviceManager.setIntegrationId.mutate({
          deviceId,
          integrationId,
        })
      },
      persistConfig: async (stableId, config) => {
        await devices.persistInitialConfig(stableId, config)
      },
      childIdsOf: async (parentDeviceId) =>
        (await this.ctx.api.deviceManager.getChildren.query({ parentDeviceId })).map((c) => c.id),
      createGateway: async ({ integrationId, name }) => {
        const gatewayKey = await this.gatewayKeyFor(integrationId)
        return this.adoptGatewayDevice(integrationId, gatewayKey, name)
      },
      removeDevice: async (deviceId) => {
        await this.ctx.api.deviceManager.remove.mutate({ deviceId })
      },
    }
  }

  // ── Integrations: one live client each ──────────────────────────────────

  /** The gateway key of an integration, from its `originStableId` (read live, not cached). */
  private async gatewayKeyFor(integrationId: string): Promise<string> {
    const all = await this.ctx.api.integrations.list.query()
    const found = all.find((i) => i.id === integrationId)
    return gatewayKeyOf({
      id: integrationId,
      originStableId: found?.originStableId,
    })
  }

  /**
   * Rebuild the clients from the live integration list: upsert one per enabled integration
   * with a usable connection, drop the ones that vanished and cascade-remove their devices.
   * Idempotent; runs at boot, after the migration created an integration, and on every
   * integration lifecycle event.
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
            this.ctx.logger.warn('Ecowitt integration has no usable connection — skipping', {
              meta: { integrationId: integration.id },
            })
            continue
          }
          if (read.passwordLocked && read.connection.transport === 'local') {
            this.ctx.logger.warn(
              'Ecowitt integration password is stored but unreadable now — not dialled with an empty one',
              { meta: { integrationId: integration.id } },
            )
            continue
          }
          await reg.upsert(
            integration.id,
            gatewayKeyOf(integration),
            integration.name,
            read.connection,
          )
          surviving.add(integration.id)
        } catch (err) {
          this.ctx.logger.warn('Ecowitt reconcile failed for integration', {
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
      this.ctx.logger.warn('Ecowitt integration reconcile failed', {
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

  private setGatewayDevicesOnline(gatewayKey: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const n = setGatewayDevicesOnline(reg.getAllForAddon(this.addonId), gatewayKey, online)
    if (n > 0) {
      this.ctx.logger.info('Ecowitt gateway devices ' + (online ? 'online' : 'offline'), {
        meta: { gatewayKey, count: n },
      })
    }
  }

  /**
   * On each snapshot: additively reconcile the sensors of every adopted group Container of this
   * gateway (re-derived from the live set and re-persisted via `applyDerivedSpec` when changed).
   */
  private handleSensorsChanged(gatewayKey: string, sensors: readonly Sensor[]): void {
    void this.reconcileGroupSensors(gatewayKey, sensors).catch((err) => {
      this.ctx.logger.warn('Ecowitt: sensor reconcile failed', {
        meta: { gatewayKey, error: errMsg(err) },
      })
    })
  }

  private async reconcileGroupSensors(
    gatewayKey: string,
    sensors: readonly Sensor[],
  ): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    const byGroup = bucketSensorsByGroup(sensors)
    for (const d of reg.getAllForAddon(this.addonId)) {
      if (d.parentDeviceId !== null || d.type !== DeviceType.Container) continue
      const cfg = await devices.loadConfig(d.id).catch((): Record<string, unknown> => ({}))
      if (cfg['system'] !== ECOWITT_SYSTEM || cfg['gatewayId'] !== gatewayKey) continue
      const nextSensors = byGroup.get(configDeviceGroup(cfg)) ?? []
      const current = Array.isArray(cfg['sensors']) ? cfg['sensors'] : []
      if (sensorsEqual(current, nextSensors)) continue
      await devices.applyDerivedSpec(d.id, {
        config: { sensors: nextSensors },
      })
      this.ctx.logger.info('Ecowitt: group sensors reconciled', {
        tags: { deviceId: d.id },
        meta: {
          group: configDeviceGroup(cfg),
          sensorCount: nextSensors.length,
        },
      })
    }
  }

  // ── Adoption: the Gateway device and the group Containers ───────────────

  private async adoptGatewayDevice(
    integrationId: string,
    gatewayKey: string,
    name: string,
  ): Promise<{ readonly deviceId: number }> {
    const devices = this.ctx.kernel.devices
    if (!devices) throw new Error('ecowitt adopt: kernel.devices unavailable')
    const stableId = gatewayDeviceNativeId(gatewayKey)
    const existing = (await devices.getAll()).find((d) => d.stableId === stableId)
    if (existing) return { deviceId: existing.id }
    const config = {
      kind: ECOWITT_GATEWAY_DEVICE_KIND,
      integrationId,
      gatewayId: gatewayKey,
      system: ECOWITT_SYSTEM,
    }
    const device = await devices.create(stableId, EcowittGatewayDevice, config, null, {
      type: DeviceType.Gateway,
      name,
      integrationId,
    })
    return { deviceId: device.id }
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildEcowittAdoptionProvider({
      getSensors: (integrationId) => {
        const key = this.requireClients().gatewayKeyOf(integrationId)
        return key === null ? [] : ecowittFacades.getSensors(key)
      },
      gatewayKeyOf: (integrationId) => this.requireClients().gatewayKeyOf(integrationId),
      listIntegrations: () => this.requireClients().list(),
      integrationName: async (integrationId) => {
        const all = await this.ctx.api.integrations.list.query()
        return all.find((i) => i.id === integrationId)?.name ?? null
      },
      isOnline: (integrationId) => this.requireClients().isOnline(integrationId),
      hasAdminLink: (integrationId) => ecowittConnections.get(integrationId)?.transport === 'local',
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
      adoptGateway: ({ integrationId, gatewayKey, name }) =>
        this.adoptGatewayDevice(integrationId, gatewayKey, name),
      adoptContainer: async ({ integrationId, gatewayKey, group, name }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('ecowitt adopt: kernel.devices unavailable')
        const sensors = bucketSensorsByGroup(ecowittFacades.getSensors(gatewayKey)).get(group) ?? []
        const config: Record<string, unknown> = {
          gatewayId: gatewayKey,
          deviceGroup: group satisfies EcowittDeviceGroup,
          sensors,
          integrationId,
          system: ECOWITT_SYSTEM,
          name,
        }
        const stableId = `${gatewayKey}:${group}`
        const device = await devices.create(stableId, EcowittContainerDevice, config, null, {
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

  // ── Discovery: the scan engine broadcasts, this addon classifies the replies ──

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async getDiscoveryModes(): Promise<readonly DiscoveryMode[]> {
    return ECOWITT_DISCOVERY_MODES
  }

  override async classifyDiscoveryHits(input: {
    hits: readonly DiscoveryHit[]
    params?: Record<string, unknown>
  }): Promise<readonly DiscoveryCandidate[]> {
    const gateways = ecowittGatewaysFromHits(input.hits)
    const known = await this.knownGatewayKeys()
    const candidates = ecowittCandidates(gateways, known)
    this.ctx.logger.info('Ecowitt discovery complete', {
      meta: { count: gateways.length, offered: candidates.length },
    })
    return candidates
  }

  /** Keys of the gateways an integration already names: by key, and by the host it dials. */
  private async knownGatewayKeys(): Promise<ReadonlySet<string>> {
    const known = new Set<string>()
    try {
      const all = await this.ctx.api.integrations.list.query()
      for (const integration of all) {
        if (integration.addonId !== this.ctx.id) continue
        known.add(gatewayKeyOf(integration))
        const connection = ecowittConnections.get(integration.id)
        if (connection?.transport === 'local') known.add(ecowittScanKey(connection.host))
      }
    } catch (err) {
      this.ctx.logger.warn('Ecowitt discovery: integrations unreadable — offering every gateway', {
        meta: { error: errMsg(err) },
      })
    }
    return known
  }

  override async adoptDiscoveredDevice(_input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    throw userError(
      'ecowitt.setup-integration',
      undefined,
      'An Ecowitt gateway is set up as an integration, not added as a device',
    )
  }

  // ── Creation: nothing is added by hand; the integration form is the way in ──

  override async supportsManualCreation(): Promise<boolean> {
    return false
  }

  /** The integration's settings form; the submitted values are stored per integration. */
  protected override globalSettingsSchema(): ConfigUISchema {
    return buildConnectionFormSchema()
  }

  protected async onGetCreationSchema(_type: DeviceType): Promise<ConfigUISchema | null> {
    return null
  }

  protected async onCreateDevice(
    _type: DeviceType,
    _config: Record<string, unknown>,
  ): Promise<CreateDeviceSpec> {
    throw new Error('Ecowitt devices are adopted from the integration')
  }

  /** Containers are keyed on the gateway; the Gateway device on its own native id. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const gatewayId = config?.['gatewayId']
    const group = config?.['deviceGroup']
    if (typeof gatewayId !== 'string' || gatewayId.length === 0) {
      throw new Error('ecowitt generateStableId: gatewayId required')
    }
    return typeof group === 'string' ? `${gatewayId}:${group}` : gatewayDeviceNativeId(gatewayId)
  }
}
