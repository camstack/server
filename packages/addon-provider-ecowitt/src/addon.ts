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
  defaultIntegrationApiOver,
  defineAddonMigrations,
  errMsg,
  EventCategory,
  type IDevice,
  type IDeviceAdoptionProvider,
  integrationInstancesCapability,
  integrationRowsPortsOverApi,
  type AddonInitResult,
  type RecordIntegrationInstances,
  type SavedDevice,
  type SystemEvent,
  type DeviceSummary,
  userError,
} from '@camstack/types'
import { z } from 'zod'
import { ECOWITT_SYSTEM, gatewayKeyOf } from './config.js'
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
  findExistingGateway,
  setGatewayDevicesOnline,
} from './ecowitt-integration-devices.js'
import {
  ECOWITT_DISCOVERY_MODES,
  ecowittCandidates,
  ecowittGatewaysFromHits,
  ecowittScanKey,
} from './ecowitt-lan-discovery.js'
import type { EcowittDeviceGroup } from './ecowitt-mapping.js'
import { findDuplicateGatewaySensors, type DuplicateScanRow } from './ecowitt-duplicate-sensors.js'
import { bucketSensorsByGroup, configDeviceGroup, sensorsEqual } from './ecowitt-sensor-groups.js'
import { EcowittReconciler, type IntegrationLifecycleKind } from './ecowitt-reconciler.js'
import {
  buildEcowittInstances,
  type EcowittConnectionBody,
  ecowittConnectionsEntryKind,
  ecowittRecordKinds,
  settingsReadOf,
} from './ecowitt-instances.js'
import { ECOWITT_ROWS_TO_RECORD_ID, ECOWITT_ROWS_TO_RECORD_MIGRATION } from './migrations/index.js'

/**
 * Ecowitt weather-station provider, `mode: account` and broker-less. An integration is one
 * gateway: its transport, host/port, password (keychain) or listener port live on the
 * integration's settings, and the addon keeps one live `@apocaliss92/nodewitt` client per
 * integration. Discovery offers the gateway itself ({@link DeviceType.Gateway}, with a link to its
 * page) and up to THREE group {@link DeviceType.Container}s (gateway / weather-station /
 * temp-sensor-ch1), each fanning out one typed sensor child per `Sensor.quantity`.
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
  private instances: RecordIntegrationInstances<EcowittConnectionBody> | null = null

  constructor() {
    super({})
  }

  protected override async onInitialize(): Promise<AddonInitResult> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('provider-ecowitt: ctx.records is required (hub-only addon)')
    }
    await records.declare(ecowittRecordKinds)
    const instances = buildEcowittInstances(records, {
      onChanged: () => this.reconcileIntegrations(),
    })
    this.instances = instances
    // The rows move BEFORE the instances provider registers (below): while it is registered the
    // hub answers from the record, not from the rows.
    this.declareRegistrySwitch({
      kind: ecowittConnectionsEntryKind,
      initialBody: (name) => ({ name }),
    })
    await this.runMigrations(this.migrationCatalogue(), { only: [ECOWITT_ROWS_TO_RECORD_ID] })
    this.clients = new EcowittClientRegistry(this.ctx.logger, {
      onOnline: (_integrationId, gatewayKey, online) =>
        this.setGatewayDevicesOnline(gatewayKey, online),
      onSensors: (_integrationId, gatewayKey, sensors) =>
        this.handleSensorsChanged(gatewayKey, sensors),
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
        { capability: integrationInstancesCapability, provider: instances.toProvider() },
      ],
    }
  }

  /** The rows-to-record catalogue. `only` names the phase that runs at initialise. */
  private migrationCatalogue() {
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('provider-ecowitt: ctx.records is required (hub-only addon)')
    }
    const rowsPorts = integrationRowsPortsOverApi({
      api: defaultIntegrationApiOver(this.ctx.api),
      secrets: this.ctx.secrets ?? null,
      records: records.kind({
        name: ecowittConnectionsEntryKind.name,
        declaration: ecowittConnectionsEntryKind.declaration,
        schema: z.record(z.string(), z.unknown()),
      }),
      log: { warn: (message) => this.ctx.logger.warn(message) },
    })
    return defineAddonMigrations([ECOWITT_ROWS_TO_RECORD_MIGRATION], rowsPorts)
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

  /** The rows persisted at boot: a Gateway saved but not restored yet is found here. */
  private savedRows: readonly SavedDevice[] = []

  private requireInstances(): RecordIntegrationInstances<EcowittConnectionBody> {
    if (!this.instances) throw new Error('Ecowitt provider not initialised')
    return this.instances
  }

  private requireClients(): EcowittClientRegistry {
    if (!this.clients) throw new Error('Ecowitt provider not initialised')
    return this.clients
  }

  /**
   * Remember the persisted rows so adopting a Gateway can see a device that is saved but not
   * restored yet, then restore as usual.
   */
  protected override async onRestoreDevices(
    savedDevices: readonly SavedDevice[],
  ): Promise<DeviceRestoreReport | void> {
    this.savedRows = savedDevices
    return super.onRestoreDevices(savedDevices)
  }

  // ── Integrations: one live client each ──────────────────────────────────

  private reconciler(): EcowittReconciler {
    const reg = this.requireClients()
    return new EcowittReconciler({
      addonId: this.ctx.id,
      logger: this.ctx.logger,
      clients: reg,
      listIntegrations: () => this.ctx.api.integrations.list.query(),
      readSettings: async (id) => settingsReadOf(await this.requireInstances().readResolved(id)),
      removeDevices: (integrationId) => this.cascadeRemoveDevicesForIntegration(integrationId),
    })
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
    this.requireInstances().onSwitched((id, enabled) => {
      void this.reconciler().onLifecycle(enabled ? 'enabled' : 'disabled', id)
    })
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, on('deleted'))
  }

  private async cascadeRemoveDevicesForIntegration(integrationId: string): Promise<number> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return 0
    return cascadeRemoveDevicesForIntegration({
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
    const changed = await this.reconcileEachContainer(gatewayKey, byGroup)
    if (changed || !this.duplicatesChecked.has(gatewayKey)) {
      await this.removeDuplicateGatewaySensors(gatewayKey)
    }
  }

  /** Gateway keys whose duplicate scan already saw spawned sensor children (idempotent anyway). */
  private readonly duplicatesChecked = new Set<string>()

  /**
   * Idempotent cleanup of the sensors minted under the `gateway` Container that duplicate a
   * sensor of the weather-station / CH1 Container (see {@link findDuplicateGatewaySensors}).
   * Goes through the normal device removal (tombstone); a read that failed removes nothing.
   */
  private async removeDuplicateGatewaySensors(gatewayKey: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    const rows: DuplicateScanRow[] = []
    for (const d of reg.getAllForAddon(this.addonId)) {
      if (d.type !== DeviceType.Container && d.type !== DeviceType.Sensor) continue
      const config = await devices.loadConfig(d.id).catch((): null => null)
      if (config === null) return
      if (config['system'] !== ECOWITT_SYSTEM || config['gatewayId'] !== gatewayKey) continue
      rows.push({
        id: d.id,
        type: d.type,
        parentDeviceId: d.parentDeviceId,
        config,
      })
    }
    const { duplicates, scanned } = findDuplicateGatewaySensors(rows)
    if (scanned > 0) this.duplicatesChecked.add(gatewayKey)
    for (const id of duplicates) {
      try {
        await devices.remove(id)
        this.ctx.logger.info('Ecowitt: duplicate sensor under the gateway container removed', {
          tags: { deviceId: id },
          meta: { gatewayKey },
        })
      } catch (err) {
        this.ctx.logger.warn('Ecowitt: duplicate sensor removal failed', {
          tags: { deviceId: id },
          meta: { gatewayKey, error: errMsg(err) },
        })
      }
    }
  }

  private async reconcileEachContainer(
    gatewayKey: string,
    byGroup: ReturnType<typeof bucketSensorsByGroup>,
  ): Promise<boolean> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return false
    let changed = false
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
      changed = true
      this.ctx.logger.info('Ecowitt: group sensors reconciled', {
        tags: { deviceId: d.id },
        meta: {
          group: configDeviceGroup(cfg),
          sensorCount: nextSensors.length,
        },
      })
    }
    return changed
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
    const existing = await findExistingGateway({
      stableId,
      live: () => devices.getAll(),
      saved: this.savedRows,
    })
    if (existing !== null) return { deviceId: existing }
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
      gatewayModel: (integrationId) => {
        const connection = ecowittConnections.get(integrationId)
        if (connection === null || connection.transport !== 'local') return null
        const model = connection.model?.trim() ?? ''
        return model.length > 0 ? model : null
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
