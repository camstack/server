import {
  BaseDeviceProvider,
  brokerCapability,
  deviceAdoptionCapability,
  DeviceType,
  errMsg,
  EventCategory,
  type AddonInitResult,
  type ConfigUISchema,
  type ConfigUISchemaWithValues,
  type CreateDeviceSpec,
  type DeviceConstructor,
  type DeviceSummary,
  type DiscoveryCandidate,
  type IBrokerProvider,
  type IDevice,
  type IDeviceAdoptionProvider,
  type SystemEvent,
} from '@camstack/types'
import { ESPHOME_DEFAULT_PORT, type EspAddonConfig, type EspBrokerEntry } from './config.js'
import { espBrokersEntryKind } from './broker-record-kinds.js'
import { EspBrokerStore } from './esphome-broker-store.js'
import { EspBrokerRegistry } from './esphome-registry.js'
import { buildEspBrokerProvider } from './esphome-broker-provider.js'
import { buildEspAdoptionProvider } from './esphome-adoption-provider.js'
import {
  cascadeRemoveDevicesForBroker,
  setBrokerDevicesOnline,
  type OfflineTarget,
} from './esphome-broker-devices.js'
import { clientLinkFactory } from './esphome-client-link.js'
import { browseBoards, proposeBoards } from './esphome-discovery.js'
import { computeBrokerCleanup, linkBrokersToIntegrations } from './esphome-reconciler.js'
import { EspContainerDevice } from './devices/esp-container-device.js'
import { EspServiceRunner } from './esphome-services.js'
import { espIrOverrides, loadIrOverrides } from './esphome-ir-overrides.js'
import { espServiceActions } from './custom-actions.js'
import type { EspServiceArgValue, EspServiceInfo } from './esphome-link.js'

export { espServiceActions as customActions } from './custom-actions.js'

const DEFAULTS: EspAddonConfig = { brokers: [] }

/**
 * ESPHome device-provider addon. One broker per board: the registry keeps a live
 * native-API session for each, the `broker` cap manages them, `device-adoption`
 * turns a connected board into a container with one child per entity, and the
 * LAN scan proposes boards that announce themselves.
 */
export class ESPHomeProviderAddon extends BaseDeviceProvider<EspAddonConfig> {
  protected readonly addonId = 'provider-esphome'
  protected readonly providerName = 'ESPHome'
  protected readonly deviceClasses: Partial<Record<DeviceType, DeviceConstructor<IDevice>>> = {
    [DeviceType.Container]: EspContainerDevice,
  }

  private registry: EspBrokerRegistry | null = null
  private services: EspServiceRunner | null = null
  private brokerStore: EspBrokerStore | null = null
  private activeBrokers: readonly EspBrokerEntry[] = []

  constructor() {
    super({ ...DEFAULTS })
  }

  protected override async onInitialize(): Promise<AddonInitResult<typeof espServiceActions>> {
    const regs = this.providerRegistrationsFromSuper(await super.onInitialize())

    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('provider-esphome: ctx.records is required (hub-only addon)')
    }
    await records.declare({ brokers: espBrokersEntryKind })
    this.brokerStore = EspBrokerStore.of(records)
    this.activeBrokers = await this.brokerStore.listResolved()
    await this.loadAllIrOverrides()

    this.registry = new EspBrokerRegistry({
      factory: clientLinkFactory,
      logger: this.ctx.logger,
      onConnected: (brokerId) => {
        this.setBrokerDevicesOnline(brokerId, true)
        void this.reprobeBrokerContainers(brokerId)
      },
      onDisconnected: (brokerId) => this.setBrokerDevicesOnline(brokerId, false),
    })
    // Does not wait for any board to answer: an unreachable board must not hold
    // the addon's boot, and it retries on its own bounded schedule.
    this.registry.restore(this.activeBrokers)

    this.ctx.logger.info('ESPHome: provider initialised', {
      meta: { brokerCount: this.activeBrokers.length },
    })

    await this.reconcileIntegrationsToBrokers()
    this.subscribeIntegrationLifecycle()

    const registry = this.registry
    this.services = new EspServiceRunner({
      getLink: (brokerId) => registry.getLink(brokerId),
      logger: this.ctx.logger,
    })

    return {
      providers: [
        ...regs,
        { capability: brokerCapability, provider: this.buildBrokerProvider() },
        { capability: deviceAdoptionCapability, provider: this.buildAdoptionProvider() },
      ],
      customActions: espServiceActions,
      actionHandlers: {
        listServices: async (input) => this.listServices(input.brokerId),
        executeService: async (input) => {
          await this.executeService(input.brokerId, input.name, input.args)
          return { ok: true }
        },
      },
    }
  }

  /** The user-defined services a connected board exposes. Throws {@link EspServiceError} when it is not connected. */
  listServices(boardId: string): readonly EspServiceInfo[] {
    return this.requireServices().listServices(boardId)
  }

  /** Run a board's service; `deviceId` tags the log line when a device asks. */
  executeService(
    boardId: string,
    name: string,
    args: Readonly<Record<string, EspServiceArgValue>>,
    deviceId?: number,
  ): Promise<void> {
    return this.requireServices().executeService(boardId, name, args, deviceId)
  }

  private requireServices(): EspServiceRunner {
    if (!this.services) throw new Error('ESPHome provider not initialised')
    return this.services
  }

  private async persistBrokerEntries(entries: readonly EspBrokerEntry[]): Promise<void> {
    this.activeBrokers = [...entries]
    await this.requireStore().replaceAll(entries)
  }

  protected override async onConfigChanged(): Promise<void> {
    const reg = this.registry
    if (!reg) return
    this.activeBrokers = await this.requireStore().listResolved()
    const persisted = this.activeBrokers
    const persistedIds = new Set(persisted.map((e) => e.id))
    const liveIds = new Set(reg.list().map((b) => b.id))

    for (const liveId of liveIds) {
      if (persistedIds.has(liveId)) continue
      try {
        await reg.removeEntry(liveId)
      } catch (err: unknown) {
        this.ctx.logger.warn('ESPHome onConfigChanged: removeEntry failed', {
          meta: { brokerId: liveId, error: errMsg(err) },
        })
      }
    }

    for (const entry of persisted) {
      if (liveIds.has(entry.id)) {
        // Reconnect only when the connection changed: re-stamping the
        // integration FK must not drop a healthy session.
        if (reg.hasSameConnection(entry.id, entry.connection)) continue
        try {
          await reg.updateEntry(entry.id, entry.connection)
        } catch (err: unknown) {
          this.ctx.logger.warn('ESPHome onConfigChanged: updateEntry failed', {
            meta: { brokerId: entry.id, error: errMsg(err) },
          })
        }
        continue
      }
      try {
        await reg.createEntry(entry.name, entry.connection, {
          id: entry.id,
          ...(entry.integrationId !== undefined ? { integrationId: entry.integrationId } : {}),
        })
      } catch (err: unknown) {
        this.ctx.logger.warn('ESPHome onConfigChanged: failed to start new board', {
          meta: { brokerId: entry.id, error: errMsg(err) },
        })
      }
    }
  }

  protected override async onShutdown(): Promise<void> {
    try {
      await this.registry?.shutdown()
    } catch (err: unknown) {
      this.ctx.logger.warn('ESPHome: provider shutdown error', { meta: { error: errMsg(err) } })
    }
    this.registry = null
    await super.onShutdown()
  }

  /** Board-scoped, so two boards can never collide on one id. */
  protected override generateStableId(_type: DeviceType, config?: Record<string, unknown>): string {
    const brokerId = String(config?.['brokerId'] ?? 'unknown')
    return `esp:${brokerId}:board`
  }

  // ── per-board transmitter override (device settings store) ──────────────

  protected override deviceSettingsSchema(): ConfigUISchema | null {
    return this.schema({
      sections: [
        {
          id: 'esp-ir',
          title: 'Infrared / RF transmitters',
          columns: 1,
          fields: [
            {
              type: 'tags' as const,
              key: 'irServices',
              label: 'Transmitter services',
              description:
                'API services of this board that become transmitters. Leave unset for automatic ' +
                '(every service whose only argument is an int[]). Write a name, or name:rf for a ' +
                'radio transmitter. Setting the list empty removes every transmitter.',
            },
          ],
        },
      ],
    })
  }

  /** Only a board container has a transmitter list; its children and other devices show nothing. */
  override async getDeviceSettings(deviceId: number): Promise<ConfigUISchemaWithValues> {
    if (this.containerById(deviceId) === undefined) return { sections: [] }
    return super.getDeviceSettings(deviceId)
  }

  override async updateDeviceSettings(
    deviceId: number,
    patch: Record<string, unknown>,
  ): Promise<void> {
    await super.updateDeviceSettings(deviceId, patch)
    const container = this.containerById(deviceId)
    if (container === undefined) return
    await this.loadIrOverridesFor([deviceId])
    await container.reprobe()
  }

  private containerById(deviceId: number): EspContainerDevice | undefined {
    return this.ctx.kernel.deviceRegistry
      ?.getAllForAddon(this.addonId)
      .find((d): d is EspContainerDevice => d instanceof EspContainerDevice && d.id === deviceId)
  }

  private async loadAllIrOverrides(): Promise<void> {
    const settings = this.ctx.settings
    if (settings === undefined) return
    await this.loadIrOverridesFor(await settings.listDeviceStoreIds())
  }

  private async loadIrOverridesFor(deviceIds: readonly number[]): Promise<void> {
    const settings = this.ctx.settings
    if (settings === undefined) return
    await loadIrOverrides({
      deviceIds,
      overrides: espIrOverrides,
      logger: this.ctx.logger,
      readStores: (ids) => settings.readDeviceStoreBatch(ids),
    })
  }

  // ── LAN scan ────────────────────────────────────────────────────────────

  override async supportsDiscovery(): Promise<boolean> {
    return true
  }

  override async discoverDevices(): Promise<readonly DiscoveryCandidate[]> {
    const found = await browseBoards()
    const known = this.activeBrokers.map((b) => b.connection.host)
    return proposeBoards(found, known).map((board) => ({
      stableId: `esphome:${board.id}`,
      type: DeviceType.Hub,
      suggestedName: board.name,
      prefilledConfig: { host: board.host, port: board.port || ESPHOME_DEFAULT_PORT },
    }))
  }

  override async adoptDiscoveredDevice(_input: {
    candidate: DiscoveryCandidate
  }): Promise<DeviceSummary> {
    throw new Error('ESPHome boards are added from the broker dialog, with their encryption key')
  }

  // ── caps ────────────────────────────────────────────────────────────────

  private buildBrokerProvider(): IBrokerProvider {
    return buildEspBrokerProvider({
      ownerAddonId: this.ctx.id,
      registry: this.requireRegistry(),
      getBrokers: () => this.activeBrokers,
      persistBrokers: (brokers) => this.persistBrokerEntries(brokers),
      cascadeRemoveDevices: (brokerId) => this.cascadeRemoveDevicesForBroker(brokerId),
      logger: this.ctx.logger,
    })
  }

  private async cascadeRemoveDevicesForBroker(brokerId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    const devices = this.ctx.kernel.devices
    if (!reg || !devices) return
    await cascadeRemoveDevicesForBroker({
      reg,
      devices,
      addonId: this.addonId,
      brokerId,
      logger: this.ctx.logger,
    })
  }

  private buildAdoptionProvider(): IDeviceAdoptionProvider {
    return buildEspAdoptionProvider({
      registry: this.requireRegistry(),
      logger: this.ctx.logger,
      getBrokerIdForIntegration: async (id) => {
        const settings = await this.ctx.api.integrations.getSettings.query({ id })
        const brokerId = settings['brokerId']
        if (typeof brokerId !== 'string') {
          throw new Error(`integration ${id} has no linked brokerId`)
        }
        return brokerId
      },
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
      adoptDevice: async ({ brokerId, integrationId, name, boardName }) => {
        const devices = this.ctx.kernel.devices
        if (!devices) throw new Error('esphome adopt: kernel.devices unavailable')
        const config = { brokerId, system: 'esphome', integrationId, boardName }
        const stableId = this.generateStableId(DeviceType.Container, config)
        const device = await devices.create(stableId, EspContainerDevice, config, null, {
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

  // ── integration → board reconcile ───────────────────────────────────────

  private async reconcileIntegrationsToBrokers(): Promise<void> {
    try {
      const all = await this.ctx.api.integrations.list.query()
      const mine = all.filter((i) => i.addonId === this.ctx.id)
      const surviving = new Set(mine.map((i) => i.id))

      const links: { id: string; brokerId: string | undefined }[] = []
      for (const integration of mine) {
        const settings = await this.ctx.api.integrations.getSettings.query({ id: integration.id })
        const brokerId = typeof settings['brokerId'] === 'string' ? settings['brokerId'] : undefined
        links.push({ id: integration.id, brokerId })
        if (brokerId === undefined) continue
        if (!this.activeBrokers.some((b) => b.id === brokerId)) {
          this.ctx.logger.warn('ESPHome integration→board: linked board not found', {
            meta: { integrationId: integration.id, brokerId },
          })
          continue
        }
        this.requireRegistry().linkIntegration(integration.id, brokerId)
      }

      const linked = linkBrokersToIntegrations(this.activeBrokers, links)
      if (linked.some((b, i) => b !== this.activeBrokers[i])) {
        await this.persistBrokerEntries(linked)
      }

      const toRemove = computeBrokerCleanup(this.activeBrokers, surviving)
      if (toRemove.length === 0) return
      for (const id of toRemove) {
        try {
          await this.requireRegistry().removeEntry(id)
          await this.cascadeRemoveDevicesForBroker(id)
        } catch (err: unknown) {
          this.ctx.logger.warn('ESPHome integration→board: cleanup failed', {
            meta: { brokerId: id, error: errMsg(err) },
          })
        }
      }
      await this.persistBrokerEntries(this.activeBrokers.filter((b) => !toRemove.includes(b.id)))
    } catch (err: unknown) {
      this.ctx.logger.warn('ESPHome integration→board reconcile failed', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private subscribeIntegrationLifecycle(): void {
    const handler = (event: SystemEvent): void => {
      const addonId = event.data['addonId']
      if (typeof addonId === 'string' && addonId !== this.ctx.id) return
      void this.reconcileIntegrationsToBrokers()
    }
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationEnabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDisabled }, handler)
    this.ctx.eventBus.subscribe({ category: EventCategory.IntegrationDeleted }, handler)
  }

  // ── settings / manual creation ──────────────────────────────────────────

  protected globalSettingsSchema(): ConfigUISchema {
    return this.schema({
      sections: [
        {
          id: 'esp-broker',
          title: 'ESPHome board',
          titleKey: 'provider-esphome:globalSettings.s_esp-broker.title',
          columns: 1,
          fields: [
            {
              type: 'info' as const,
              key: 'brokerHelp',
              label: 'Boards are managed separately',
              labelKey: 'provider-esphome:globalSettings.s_esp-broker.brokerHelp.label',
              content:
                'This integration links to an ESPHome board managed under External systems → Brokers.',
            },
          ],
        },
      ],
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
    throw new Error('ESPHome devices are adopted from a connected board, not created manually')
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private setBrokerDevicesOnline(brokerId: string, online: boolean): void {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const devices: ReadonlyArray<OfflineTarget> = reg.getAllForAddon(this.addonId)
    const n = setBrokerDevicesOnline(devices, brokerId, online)
    if (n > 0) {
      this.ctx.logger.info('ESPHome: board devices ' + (online ? 'online' : 'offline'), {
        meta: { brokerId, count: n },
      })
    }
  }

  /** Re-run the accessory reconcile of a board's container once its entity list exists. */
  private async reprobeBrokerContainers(brokerId: string): Promise<void> {
    const reg = this.ctx.kernel.deviceRegistry
    if (!reg) return
    const containers = reg
      .getAllForAddon(this.addonId)
      .filter(
        (d): d is EspContainerDevice =>
          d instanceof EspContainerDevice && d.config.get('brokerId') === brokerId,
      )
    for (const container of containers) {
      try {
        await container.reprobe()
      } catch (err: unknown) {
        this.ctx.logger.warn('ESPHome: container reprobe failed', {
          tags: { deviceId: container.id },
          meta: { brokerId, error: errMsg(err) },
        })
      }
    }
  }

  private requireRegistry(): EspBrokerRegistry {
    if (!this.registry) throw new Error('ESPHome provider not initialised')
    return this.registry
  }

  private requireStore(): EspBrokerStore {
    if (!this.brokerStore) throw new Error('ESPHome provider not initialised')
    return this.brokerStore
  }
}
